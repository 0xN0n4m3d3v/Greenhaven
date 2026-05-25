// DiceBubble — true 3D icosahedron d20 over the NPC reply.
//
// Geometry credit: stasondrero/d20-dice-rotate (CSS recipe). Builds
// the icosahedron from 20 triangle <section> divs arranged in 4
// pentagonal bands using `transform-style: preserve-3d`. Each face
// carries its number; as the dice rotates the player sees multiple
// faces sweep past the camera — real geometric volume, not a flat
// sprite.
//
// Visual states:
//   * "rolling" — continuous high-speed rotation, no specific face
//     selected.
//   * "rolled"  — rotation slows to a gentle drift; the actual roll
//     number is shown big in the side panel along with DC + verdict.

import {motion, AnimatePresence} from 'motion/react';
import {useTranslation} from './i18n';

export type DiceRoll = {
    action_id?: string;
    description?: string;
    roll: number;
    /** Null for pure-damage / no-DC rolls. */
    dc?: number | null;
    /** Null when no DC was supplied (no pass/fail meaning). */
    outcome?: 'success' | 'failure' | null;
    /**
     * Who threw the die. Drives the bubble colour: 'player' (default)
     * is the warm amber treatment; 'npc' is red — used when the model
     * is rolling FOR an NPC (their attack against the player, their
     * save against a curse, etc.). Mirrors what the model passed via
     * `dice_check(roller=…)` on the server.
     */
    roller?: 'player' | 'npc';
    /** Blades-in-the-Dark style situational tags (spec 16). When set,
     *  rendered as small chips alongside the roll/DC line. */
    position?: 'controlled' | 'risky' | 'desperate';
    effect?: 'limited' | 'standard' | 'great';
};

type Props = {
    state: 'rolling' | 'rolled';
    roll?: DiceRoll | null;
};

// Arrangement of face numbers around the icosahedron. The order
// matters only cosmetically — each section index gets one number;
// any 1..20 permutation gives a valid die. We emit in CSS section
// order (1..20) directly — index i → section nth-of-type(i+1).
const FACES: number[] = [];
for (let i = 0; i < 20; i++) FACES.push(((i * 7) % 20) + 1);
// Force first face to 20 for crit visibility (cosmetic).
FACES[0] = 20;
FACES[1] = 1;

export function DiceBubble({state, roll}: Props) {
    const {t} = useTranslation();
    const isRolling = state === 'rolling' || !roll;
    const outcomeClass = roll ? `outcome-${roll.outcome}` : '';
    const rollerClass = roll?.roller === 'npc' ? 'roller-npc' : 'roller-player';

    return (
        <motion.div
            className={`dice-bubble ${isRolling ? 'rolling' : 'rolled'} ${outcomeClass} ${rollerClass}`}
            initial={{opacity: 0, y: 10, scale: 0.85}}
            animate={{opacity: 1, y: 0, scale: 1}}
            exit={{opacity: 0, y: -8, scale: 0.9}}
            transition={{type: 'spring', stiffness: 320, damping: 22}}
        >
            <div className="d20-stage">
                <div className={`d20 ${isRolling ? 'fast' : 'slow'} ${roll?.outcome === 'success' ? 'glow-pass' : ''} ${roll?.outcome === 'failure' ? 'glow-fail' : ''}`}>
                    <div className="d20-dice">
                        {FACES.map((n, idx) => (
                            <section key={idx} data-num={n}>
                                <span className="d20-num">{n}</span>
                            </section>
                        ))}
                    </div>
                </div>
            </div>

            <div className="dice-meta">
                <AnimatePresence mode="wait">
                    {isRolling ? (
                        <motion.div
                            key="rolling"
                            className="dice-line dice-rolling"
                            initial={{opacity: 0}}
                            animate={{opacity: 1}}
                            exit={{opacity: 0}}
                        >
                            <span className="dice-dots">
                                <span/><span/><span/>
                            </span>
                            <span className="dice-rolling-text">{(() => {
                                const v = t('dice.rolling');
                                // i18n returns the key itself when missing —
                                // show a neutral ellipsis fallback so we
                                // don't render the literal "dice.rolling".
                                return v && v !== 'dice.rolling' ? v : '…';
                            })()}</span>
                        </motion.div>
                    ) : (
                        <motion.div
                            key="rolled"
                            className="dice-line"
                            initial={{opacity: 0, x: 6}}
                            animate={{opacity: 1, x: 0}}
                            transition={{delay: 0.05}}
                        >
                            <span className="dice-vs">
                                <strong>{roll!.roll}</strong>
                                {roll!.dc != null && (
                                    <>
                                        <span className="dice-vs-sep">{t('dice.vs_dc')}</span>
                                        <span className="dice-dc">{roll!.dc}</span>
                                    </>
                                )}
                            </span>
                            {roll!.outcome && (
                                <span className={`dice-verdict ${roll!.outcome}`}>
                                    {roll!.outcome === 'success' ? t('dice.success') : t('dice.failure')}
                                </span>
                            )}
                            {roll!.position && (
                                <span className={`chip-pos chip-${roll!.position}`}>{roll!.position}</span>
                            )}
                            {roll!.effect && (
                                <span className={`chip-eff chip-${roll!.effect}`}>{roll!.effect}</span>
                            )}
                        </motion.div>
                    )}
                </AnimatePresence>
                {!isRolling && roll!.description && (
                    <motion.div
                        className="dice-desc"
                        initial={{opacity: 0}}
                        animate={{opacity: 1}}
                        transition={{delay: 0.2}}
                    >
                        {roll!.description}
                    </motion.div>
                )}
            </div>
        </motion.div>
    );
}
