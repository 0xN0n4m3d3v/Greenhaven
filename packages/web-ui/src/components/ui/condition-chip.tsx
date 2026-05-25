import type {CSSProperties, ReactNode} from 'react';
import {Tooltip, TooltipContent, TooltipTrigger} from './tooltip';

export interface ConditionChipDetail {
  label: string;
  value?: string | number | null;
}

interface ConditionChipProps {
  label: string;
  details?: ConditionChipDetail[];
  description?: ReactNode;
  tone?: 'neutral' | 'warn' | 'destructive' | 'positive';
  style?: CSSProperties;
}

export function ConditionChip({
  label,
  details = [],
  description,
  tone = 'neutral',
  style,
}: ConditionChipProps) {
  const hasBody = details.length > 0 || description != null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="condition-chip"
          data-tone={tone}
          style={style}
        >
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" align="start">
        <div className="condition-chip-tooltip">
          <div
            className={`condition-chip-tooltip__title${hasBody ? ' has-body' : ''}`}
          >
            {label}
          </div>
          {details.length > 0 && (
            <div className="condition-chip-tooltip__details">
              {details.map((d, i) => (
                <span key={`${d.label}-${i}`}>
                  <span className="condition-chip-tooltip__detail-label">
                    {d.label}:{' '}
                  </span>
                  <span className="condition-chip-tooltip__detail-value">
                    {d.value ?? '-'}
                  </span>
                </span>
              ))}
            </div>
          )}
          {description && (
            <div
              className={`condition-chip-tooltip__description${details.length ? ' has-details' : ''}`}
            >
              {description}
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
