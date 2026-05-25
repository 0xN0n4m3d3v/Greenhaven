/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 36 §6 — prompt-injection neutralizer.
//
// Layer-1 regex pass over player input. Catches OWASP top-pattern
// jailbreaks: instruction overrides, identity attacks, ChatML / Llama
// delimiter injection, system-prompt extraction. We do NOT block —
// false positives in a 21+ RP game are infuriating. Instead we wrap
// the offending input as `[USER_INPUT]"…"[/USER_INPUT]` so the model
// sees it as quoted literal user content and treats it as in-fiction
// dialogue rather than authoritative instructions.
//
// X-3 follow-up — the flat regex array is now split into two typed
// signature groups so each pattern carries its own narrowly-scoped
// annotation:
//   * `protocol_delimiter` — LLM wire-format tokens (ChatML, Llama-2).
//     These are not natural language; no human player types
//     `<|im_start|>`, so they are legitimate `LANGUAGE-REGEX-OK`.
//   * `natural_language_attack` — English-only jailbreak phrases
//     ("ignore previous instructions", "developer mode", "jailbreak").
//     Each pattern carries a narrowly-scoped security-exception
//     comment that documents the guard's opportunistic, non-blocking
//     contract: a missed non-English variant still results in safe
//     gameplay because the broker prompt already quarantines player
//     text as in-fiction dialogue. The classifier + broker prompt
//     remain the canonical security boundary; layer-1 here is a
//     belt-and-suspenders neutraliser, not a security perimeter.

export type InjectionSignatureKind =
  | 'protocol_delimiter'
  | 'natural_language_attack';

export interface InjectionSignature {
  /** Stable identifier for telemetry / tests; never user-facing. */
  name: string;
  kind: InjectionSignatureKind;
  pattern: RegExp;
}

export const PROTOCOL_DELIMITER_SIGNATURES: ReadonlyArray<InjectionSignature> = [
  {
    name: 'chatml_im_start',
    kind: 'protocol_delimiter',
    // LANGUAGE-REGEX-OK: ChatML `<|im_start|>` role delimiter. LLM wire-format token, never typed by a player; literal protocol string.
    pattern: /<\|im_start\|>/i,
  },
  {
    name: 'chatml_im_end',
    kind: 'protocol_delimiter',
    // LANGUAGE-REGEX-OK: ChatML `<|im_end|>` role-end delimiter. LLM wire-format token, never typed by a player.
    pattern: /<\|im_end\|>/i,
  },
  {
    name: 'llama_inst_open',
    kind: 'protocol_delimiter',
    // LANGUAGE-REGEX-OK: Llama-2 `[INST]` instruction-block opener. Wire-format prompt-template token.
    pattern: /\[INST\]/i,
  },
  {
    name: 'llama_inst_close',
    kind: 'protocol_delimiter',
    // LANGUAGE-REGEX-OK: Llama-2 `[/INST]` instruction-block closer. Wire-format prompt-template token.
    pattern: /\[\/INST\]/i,
  },
  {
    name: 'llama_sys_open',
    kind: 'protocol_delimiter',
    // LANGUAGE-REGEX-OK: Llama-2 `<<SYS>>` system-block opener. Wire-format prompt-template token.
    pattern: /<<SYS>>/i,
  },
  {
    name: 'llama_sys_close',
    kind: 'protocol_delimiter',
    // LANGUAGE-REGEX-OK: Llama-2 `<</SYS>>` system-block closer. Wire-format prompt-template token.
    pattern: /<<\/SYS>>/i,
  },
];

export const NATURAL_LANGUAGE_ATTACK_SIGNATURES: ReadonlyArray<InjectionSignature> = [
  {
    name: 'ignore_previous_instructions',
    kind: 'natural_language_attack',
    // LANGUAGE-REGEX-OK: English-only OWASP `ignore (all)? (previous|prior|above) instructions?` jailbreak signature. Layer-1 guard is non-blocking — `guardPlayerInput` wraps the matched text as `[USER_INPUT]"…"[/USER_INPUT]` so the model treats it as quoted in-fiction dialogue, never as authoritative instructions. A missed non-English variant remains safe because the broker prompt already quarantines player text; this regex is a best-effort neutraliser, not a security boundary.
    pattern: /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?/i,
  },
  {
    name: 'you_are_now_role_assignment',
    kind: 'natural_language_attack',
    // (3-letter words "you"/"are"/"now" already fall below the X-3 rule threshold; this entry stays alongside its English siblings for parity and is exercised by the focused test below.)
    pattern: /you\s+are\s+now\s+(?:a|an)\s+/i,
  },
  {
    name: 'system_role_prefix',
    kind: 'natural_language_attack',
    // LANGUAGE-REGEX-OK: English `system: you are` role-override signature. Same opportunistic non-blocking contract as `ignore_previous_instructions` above.
    pattern: /system\s*:\s*you\s+are/i,
  },
  {
    name: 'forget_previous',
    kind: 'natural_language_attack',
    // LANGUAGE-REGEX-OK: English `forget (everything|all) (above|previous)` jailbreak signature. Opportunistic non-blocking neutraliser; same contract as `ignore_previous_instructions`.
    pattern: /forget\s+(?:everything|all)\s+(?:above|previous)/i,
  },
  {
    name: 'reveal_system_prompt',
    kind: 'natural_language_attack',
    // LANGUAGE-REGEX-OK: English `reveal (your)? (system)? prompt` exfiltration signature. Opportunistic non-blocking neutraliser; same contract as `ignore_previous_instructions`.
    pattern: /reveal\s+(?:your\s+)?(?:system\s+)?prompt/i,
  },
  {
    name: 'print_instructions',
    kind: 'natural_language_attack',
    // LANGUAGE-REGEX-OK: English `print (your)? (initial)? instructions` exfiltration signature. Opportunistic non-blocking neutraliser; same contract as `ignore_previous_instructions`.
    pattern: /print\s+(?:your\s+)?(?:initial\s+)?instructions/i,
  },
  {
    name: 'developer_mode',
    kind: 'natural_language_attack',
    // LANGUAGE-REGEX-OK: English `developer mode` ChatGPT-jailbreak signature. Opportunistic non-blocking neutraliser; same contract as `ignore_previous_instructions`.
    pattern: /developer\s+mode/i,
  },
  {
    name: 'jailbreak_keyword',
    kind: 'natural_language_attack',
    // LANGUAGE-REGEX-OK: bare `jailbreak` keyword. Opportunistic non-blocking neutraliser; same contract as `ignore_previous_instructions`.
    pattern: /jailbreak/i,
  },
];

export const INJECTION_SIGNATURES: ReadonlyArray<InjectionSignature> = [
  ...PROTOCOL_DELIMITER_SIGNATURES,
  ...NATURAL_LANGUAGE_ATTACK_SIGNATURES,
];

export interface GuardResult {
  text: string;
  flagged: boolean;
  matchedPattern?: string;
  /**
   * X-3 follow-up — when `flagged`, names the signature that fired so
   * telemetry and tests can distinguish protocol-delimiter injection
   * (which a human player never types) from a natural-language attack
   * signature. Optional to keep `GuardResult` wire-compatible with the
   * previous shape.
   */
  signatureName?: string;
  signatureKind?: InjectionSignatureKind;
}

export function guardPlayerInput(raw: string): GuardResult {
  for (const signature of INJECTION_SIGNATURES) {
    const m = raw.match(signature.pattern);
    if (m) {
      return {
        text: `[USER_INPUT]"${escapeGuardPayload(raw)}"[/USER_INPUT]`,
        flagged: true,
        matchedPattern: m[0],
        signatureName: signature.name,
        signatureKind: signature.kind,
      };
    }
  }
  return {text: raw, flagged: false};
}

/**
 * Escape player text before it lands inside the
 * `[USER_INPUT]"…"[/USER_INPUT]` wrapper. Without this, a hostile
 * input that literally contains the closing `[/USER_INPUT]` sentinel
 * (or a matching `[USER_INPUT]` opener) would produce an apparent
 * early close of the neutralisation wrapper, leaving the trailing
 * player text outside quotes and visible to the model as an
 * authoritative instruction. The wrapper is a literal-string
 * convention, not a JSON value, so the previous backslash escape of
 * `"` alone was insufficient.
 *
 * Single-pass char scan, in this order — `\` is doubled first so we
 * never double-escape the bracket escapes we emit, `"` is doubled
 * so the quoted span stays balanced, and `[` / `]` become their
 * literal `[` / `]` escape forms so neither
 * `[USER_INPUT]` nor `[/USER_INPUT]` can be synthesised from inside
 * the payload. The output is the human-readable escape-sequence
 * text (the six characters `\`, `u`, `0`, `0`, `5`, `B` / `D`), not
 * an interpreted Unicode codepoint — it is the model that reads
 * the wrapped payload, and emitting the readable escape preserves
 * the original bytes for any audit log that quotes the payload
 * verbatim. No regex, no `Number(...)` coercion — keeps the X-3
 * rule satisfied.
 */
export function escapeGuardPayload(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\') {
      out += '\\\\';
      continue;
    }
    if (ch === '"') {
      out += '\\"';
      continue;
    }
    if (ch === '[') {
      out += '\\u005B';
      continue;
    }
    if (ch === ']') {
      out += '\\u005D';
      continue;
    }
    out += ch;
  }
  return out;
}
