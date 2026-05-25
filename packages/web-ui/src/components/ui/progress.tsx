// Adapted from shadcn-ui/ui (MIT) — Progress primitive (Radix-backed).
import * as ProgressPrimitive from '@radix-ui/react-progress';
import * as React from 'react';
import {cn} from '@/lib/utils';

export const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root>
>(({className, value, ...props}, ref) => (
  <ProgressPrimitive.Root
    ref={ref}
    className={cn(
      'relative h-2 w-full overflow-hidden bg-[hsl(var(--secondary)/0.4)]',
      className,
    )}
    {...props}
  >
    <ProgressPrimitive.Indicator
      className="h-full w-full flex-1 bg-[hsl(var(--primary))] transition-all"
      style={{transform: `translateX(-${100 - (value ?? 0)}%)`}}
    />
  </ProgressPrimitive.Root>
));
Progress.displayName = ProgressPrimitive.Root.displayName;
