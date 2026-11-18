/**
 * useNarrowViewport — true when the window is narrower than `breakpoint`
 * (default 900). Used to densify chrome (collapse Analysis, tighten TimeSlider)
 * without a CSS framework.
 */

import { useEffect, useState } from 'react';

export function useNarrowViewport(breakpoint = 900): boolean {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < breakpoint : false,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      const onResize = () => setNarrow(window.innerWidth < breakpoint);
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    }
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const apply = () => setNarrow(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [breakpoint]);

  return narrow;
}
