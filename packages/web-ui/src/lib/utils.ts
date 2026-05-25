// Spec 29 — shadcn-style className composition helper. Combines clsx
// (truthy filtering, array/object support) with tailwind-merge (last-
// wins for conflicting Tailwind utility classes). All shadcn-derived
// primitives import this from `@/lib/utils`.

import {clsx, type ClassValue} from 'clsx';
import {twMerge} from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
