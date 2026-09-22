import { useEffect, useRef } from 'react';
import { Layers3, ScanFace } from 'lucide-react';
import artwork from '../assets/photo-discovery.webp';

/** Compositor-only depth. No WebGL, animation loop, tracking, or photo processing. */
export function PhotoDepth() {
  const stage = useRef<HTMLElement>(null);
  useEffect(() => {
    const node = stage.current;
    if (!node) return;
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    let visible = true;
    const update = () => {
      frame = 0;
      const offset =
        !preference.matches && visible
          ? Math.max(
              -18,
              Math.min(18, -node.getBoundingClientRect().top * 0.045),
            )
          : 0;
      node.style.setProperty('--depth-y', `${offset}px`);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = Boolean(entry?.isIntersecting);
      if (visible) schedule();
    });
    observer.observe(node);
    window.addEventListener('scroll', schedule, { passive: true });
    preference.addEventListener('change', schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('scroll', schedule);
      preference.removeEventListener('change', schedule);
    };
  }, []);
  return (
    <figure
      ref={stage}
      className="photo-depth"
      aria-label="Photo discovery illustration"
    >
      <div className="depth-stage">
        <div className="depth-orbit orbit-one" aria-hidden="true" />
        <div className="depth-orbit orbit-two" aria-hidden="true" />
        <div className="depth-orbit orbit-three" aria-hidden="true" />
        <div className="depth-print">
          <div className="depth-caption">
            <Layers3 size={14} /> ONE COLLECTION. YOUR MOMENTS.
          </div>
          <img
            className="hero-logo"
            src={artwork}
            width="1024"
            height="764"
            fetchPriority="high"
            alt="Illustration of a selfie connected to a matching face among layered wedding and conference photos"
          />
        </div>
        <div className="depth-chip">
          <ScanFace size={22} />
          <span>
            A familiar face.<small>A shorter search.</small>
          </span>
        </div>
      </div>
      <figcaption>
        Illustration only. Displayed scores are not measured results.
      </figcaption>
    </figure>
  );
}
