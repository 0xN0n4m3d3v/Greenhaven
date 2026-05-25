import {useEffect, useRef, type ReactNode} from 'react';

interface StepDef {
  index: number;
  title: string;
  subtitle: string;
}

interface Props {
  step: number;
  steps: StepDef[];
  canBack: boolean;
  canNext: boolean;
  busy: boolean;
  busyLabel?: string;
  backLabel: string;
  nextLabel: string;
  finalLabel?: string;
  onBack: () => void;
  onNext: () => void;
  children: ReactNode;
  errorMessage?: string | null;
  /** Hide the next button entirely (e.g. when the step content owns its
   *  own commit affordance, like CardReviewPanel's "step into Greenhaven"). */
  hideNext?: boolean;
  /** Render inside another dialog/surface instead of owning the viewport. */
  embedded?: boolean;
}

export function CreatorChrome({
  step,
  steps,
  canBack,
  canNext,
  busy,
  busyLabel,
  backLabel,
  nextLabel,
  finalLabel,
  onBack,
  onNext,
  children,
  errorMessage,
  hideNext,
  embedded = false,
}: Props) {
  const scrollFrameRef = useRef<HTMLElement | null>(null);
  const current = steps[step];
  const isLast = step === steps.length - 1;
  const stepCountLabel = `Step ${step + 1} of ${steps.length}`;

  useEffect(() => {
    const frame = scrollFrameRef.current;
    if (!frame) return;
    frame.scrollTop = 0;
  }, [step]);

  useEffect(() => {
    const frame = scrollFrameRef.current;
    if (!frame) return;

    const scrollBy = (delta: number) => {
      frame.scrollTop = Math.max(
        0,
        Math.min(frame.scrollTop + delta, frame.scrollHeight - frame.clientHeight),
      );
    };

    const onWheel = (event: WheelEvent) => {
      if (!event.deltaY) return;
      if (event.target && canNestedElementScroll(event.target, frame, event.deltaY)) {
        return;
      }
      event.preventDefault();
      scrollBy(event.deltaY);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isTypingTarget(event.target)) return;
      const page = Math.max(160, frame.clientHeight * 0.82);
      let handled = true;
      switch (event.key) {
        case 'PageDown':
          scrollBy(page);
          break;
        case 'PageUp':
          scrollBy(-page);
          break;
        case 'ArrowDown':
          scrollBy(56);
          break;
        case 'ArrowUp':
          scrollBy(-56);
          break;
        case 'Home':
          frame.scrollTop = 0;
          break;
        case 'End':
          frame.scrollTop = frame.scrollHeight;
          break;
        default:
          handled = false;
      }
      if (handled) event.preventDefault();
    };

    frame.addEventListener('wheel', onWheel, {passive: false});
    window.addEventListener('keydown', onKeyDown, {capture: true});
    return () => {
      frame.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown, {capture: true});
    };
  }, []);

  return (
    <section
      className={`creator-overlay${embedded ? ' creator-overlay--embedded' : ''}`}
      ref={scrollFrameRef}
      role={embedded ? 'region' : 'dialog'}
      aria-modal={embedded ? undefined : 'true'}
      aria-label={current?.title ?? 'Character creator'}
    >
    <div className={`creator-chrome${embedded ? ' creator-chrome--embedded' : ''}`}>
      <div className="creator-chrome-vignette" aria-hidden />

      <aside className="creator-bookmark" aria-label="Creator steps">
        <ol>
          {steps.map(s => (
            <li
              key={s.index}
              className={
                s.index === step ? 'active' :
                s.index < step  ? 'past'   :
                                  'future'
              }
              aria-current={s.index === step ? 'step' : undefined}
            >
              <span className="num">{String(s.index + 1).padStart(2, '0')}</span>
              <span className="copy">
                <span className="title">{s.title}</span>
                <span className="subtitle">{s.subtitle}</span>
              </span>
            </li>
          ))}
        </ol>
      </aside>

      <main className="creator-page" role="region" aria-label={current?.title}>
        <header className="creator-page-header">
          <div className="creator-page-status">
            <p className="creator-page-kicker">{stepCountLabel}</p>
            <span className="creator-page-mode">
              {busy && busyLabel ? busyLabel : 'Draft'}
            </span>
          </div>
          <h1>{current?.title}</h1>
          <p className="creator-page-subtitle">{current?.subtitle}</p>
        </header>

        <div className="creator-page-body">
          {children}
        </div>

        {errorMessage && (
          <p className="creator-page-error">{errorMessage}</p>
        )}

        <footer className="creator-page-footer">
          <button
            type="button"
            className="creator-page-nav back"
            disabled={!canBack || busy}
            onClick={onBack}
          >
            {'<'} {backLabel}
          </button>
          {!hideNext && (
            <button
              type="button"
              className={`creator-page-nav next ${isLast ? 'final' : ''}`}
              disabled={!canNext || busy}
              onClick={onNext}
            >
              {busy && busyLabel
                ? busyLabel
                : isLast && finalLabel
                  ? finalLabel
                  : nextLabel}
              {!busy && ' >'}
            </button>
          )}
        </footer>
      </main>
    </div>
    </section>
  );
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return (
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    target.isContentEditable
  );
}

function canNestedElementScroll(
  target: EventTarget,
  root: HTMLElement,
  deltaY: number,
): boolean {
  if (!(target instanceof HTMLElement)) return false;
  let el: HTMLElement | null = target;
  while (el && el !== root) {
    const style = window.getComputedStyle(el);
    const canScroll =
      /(auto|scroll|overlay)/.test(style.overflowY) &&
      el.scrollHeight > el.clientHeight + 1;
    if (canScroll) {
      const atTop = el.scrollTop <= 0;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
      if ((deltaY < 0 && !atTop) || (deltaY > 0 && !atBottom)) {
        return true;
      }
    }
    el = el.parentElement;
  }
  return false;
}
