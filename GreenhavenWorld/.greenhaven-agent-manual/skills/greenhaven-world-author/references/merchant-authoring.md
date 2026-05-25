# Merchant Authoring

Use this reference when a writer asks for a merchant, innkeeper, fence, broker,
guard, healer, trainer, companion-for-hire, storage keeper, or any NPC/item that
sells something.

## Currency

Use the canonical currency mentions in prices:

- `@Copper coin`
- `@Silver coin`
- `@Gold coin`

Canonical exchange:

- `1 @Gold coin = 10 @Silver coin`
- `1 @Silver coin = 10 @Copper coin`
- `1 @Gold coin = 100 @Copper coin`

Do not localize these `@` tokens.

## NPC Section

Add this section to the NPC only when they sell something:

```md
## Merchant

Я продаю: ...

Мои цены:

- service or item - 2 @Copper coin;
- larger service - 1 @Silver coin;
- risky access - 1 @Gold coin.

Я считаю услугу оплаченной, когда: ...
Я помню о платежах героя: кто платил, сколько, за что, была ли сдача, долг,
аванс, срок действия доступа или услуги.
```

Keep the prose in the writer's language. Keep the coin mentions canonical.

## Materializes

Use English parser keys inside `Materializes`, even when the surrounding prose
is Russian:

```md
## Materializes

- Когда герой платит за временный доступ:
  - Entity: @Example access token
  - Type: item/access-state
  - Scope: current location
  - Effect: герой получает право пользоваться услугой до конца дня.
```

The universal target types are:

- `location`
- `item`
- `NPC`
- `scene`
- `quest`
- `service`
- `access`
- `state`

If the target note exists, the compiler links or opens it. If it does not
exist, the transformer treats the `Entity:` target as an explicit
materialization candidate.

Do not use localized parser keys such as Russian field names. Human prose can
be localized; the keys stay `Entity`, `Type`, `Scope`, and `Effect`.
