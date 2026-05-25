export function abilityMod(score: number): number {
  return Math.floor((score - 10) / 2);
}

export function rollD20(): number {
  return Math.floor(Math.random() * 20) + 1;
}

export function rollDamage(sides: number): number {
  return Math.floor(Math.random() * sides) + 1;
}
