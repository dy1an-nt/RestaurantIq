import { useCallback, useEffect, useState } from 'react';
import Icon from './Icons';
import restaurantInterior from '../assets/landing/restaurant-interior.webp';
import cafeInterior from '../assets/landing/cafe-interior.webp';
import barInterior from '../assets/landing/bar-interior.webp';

const AUTOPLAY_DELAY_MS = 6000;

const SLIDES = [
  {
    src: restaurantInterior,
    venue: 'Restaurant',
    photographer: 'Pixabay',
    source: 'https://www.pexels.com/photo/empty-bar-filled-with-lights-260922/',
    alt: 'Warmly lit restaurant interior with an empty bar and dining area',
  },
  {
    src: cafeInterior,
    venue: 'Cafe',
    photographer: 'Alina Matveycheva',
    source: 'https://www.pexels.com/photo/tables-and-chairs-in-a-restaurant-18234202/',
    alt: 'Quiet cafe seating area with small wooden tables, chairs, and flower vases',
  },
  {
    src: barInterior,
    venue: 'Bar and cafe',
    photographer: 'Rachel Claire',
    source: 'https://www.pexels.com/photo/bar-interior-design-5865413/',
    alt: 'Empty industrial bar and cafe interior with brick walls and counter seating',
  },
] as const;

const HospitalityCarousel = () => {
  const [activeIndex, setActiveIndex] = useState(0);
  const [userPaused, setUserPaused] = useState(false);
  const [userForcedPlayback, setUserForcedPlayback] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [documentHidden, setDocumentHidden] = useState(() => document.hidden);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const [manualNavigationCount, setManualNavigationCount] = useState(0);
  const motionPaused = prefersReducedMotion && !userForcedPlayback;
  const interactionPaused = (hovered || focusWithin) && !userForcedPlayback;
  const autoplayPaused = userPaused || motionPaused || interactionPaused || documentHidden;

  const navigateManually = useCallback((nextIndex: number) => {
    setActiveIndex((nextIndex + SLIDES.length) % SLIDES.length);
    setManualNavigationCount((count) => count + 1);
  }, []);

  const showPrevious = useCallback(() => {
    setActiveIndex((current) => (current - 1 + SLIDES.length) % SLIDES.length);
    setManualNavigationCount((count) => count + 1);
  }, []);

  const showNext = useCallback(() => {
    setActiveIndex((current) => (current + 1) % SLIDES.length);
    setManualNavigationCount((count) => count + 1);
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handleMotionPreference = (event: MediaQueryListEvent) => {
      setPrefersReducedMotion(event.matches);
      if (event.matches) setUserForcedPlayback(false);
    };

    mediaQuery.addEventListener('change', handleMotionPreference);
    return () => mediaQuery.removeEventListener('change', handleMotionPreference);
  }, []);

  useEffect(() => {
    const handleVisibilityChange = () => setDocumentHidden(document.hidden);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  useEffect(() => {
    if (autoplayPaused) return undefined;

    const intervalId = window.setInterval(() => {
      setActiveIndex((current) => (current + 1) % SLIDES.length);
    }, AUTOPLAY_DELAY_MS);

    return () => window.clearInterval(intervalId);
  }, [autoplayPaused, manualNavigationCount]);

  const togglePlayback = () => {
    if (userPaused || motionPaused) {
      setUserPaused(false);
      setUserForcedPlayback(true);
    } else {
      setUserPaused(true);
      setUserForcedPlayback(false);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      showPrevious();
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      showNext();
    }
  };

  const playbackPaused = userPaused || motionPaused;

  return (
    <div
      role="region"
      aria-roledescription="carousel"
      aria-label="Hospitality interiors"
      className="border border-line bg-surface rounded-lg shadow-shot overflow-hidden"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocusWithin(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusWithin(false);
      }}
      onKeyDown={handleKeyDown}
    >
      <div className="bg-navy-900">
        {SLIDES.map((slide, index) => (
          <figure
            key={slide.source}
            hidden={index !== activeIndex}
            aria-hidden={index !== activeIndex}
            aria-roledescription="slide"
            aria-label={`${slide.venue}, slide ${index + 1} of ${SLIDES.length}`}
          >
            <div className="aspect-[8/5] overflow-hidden">
              <img
                src={slide.src}
                alt={slide.alt}
                width={1600}
                height={1000}
                loading={index === 0 ? 'eager' : 'lazy'}
                className="block h-full w-full object-cover"
              />
            </div>
            <figcaption className="flex min-h-[52px] items-center border-t border-white/10 bg-navy-900 px-4 py-3 text-[12.5px] font-semibold text-white/75">
              <span>Illustrative {slide.venue.toLowerCase()} | Photo by{' '}</span>
              <a
                href={slide.source}
                target="_blank"
                rel="noreferrer"
                className="ml-1 text-white underline decoration-white/40 underline-offset-4 hover:decoration-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white rounded-sm"
              >
                {slide.photographer}
              </a>
            </figcaption>
          </figure>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-canvas px-3 py-2.5">
        <div role="group" className="flex items-center gap-1" aria-label="Choose a slide">
          {SLIDES.map((slide, index) => (
            <button
              key={slide.source}
              type="button"
              aria-label={`Show slide ${index + 1}: ${slide.venue}`}
              aria-current={index === activeIndex ? 'true' : undefined}
              onClick={() => navigateManually(index)}
              className="flex h-11 w-11 items-center justify-center rounded-md text-navy-700 hover:bg-navy-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy-500 focus-visible:ring-offset-2"
            >
              <span className={`block h-2.5 w-2.5 rounded-full ${index === activeIndex ? 'bg-navy-700' : 'bg-ink-3/35'}`} />
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Previous slide"
            onClick={showPrevious}
            className="flex h-11 w-11 items-center justify-center rounded-md text-ink-2 hover:bg-white hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy-500 focus-visible:ring-offset-2"
          >
            <Icon name="chevron" size={20} className="rotate-90" />
          </button>
          <button
            type="button"
            aria-label="Next slide"
            onClick={showNext}
            className="flex h-11 w-11 items-center justify-center rounded-md text-ink-2 hover:bg-white hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy-500 focus-visible:ring-offset-2"
          >
            <Icon name="chevron" size={20} className="-rotate-90" />
          </button>
          <button
            type="button"
            aria-label={playbackPaused ? 'Play slideshow' : 'Pause slideshow'}
            onClick={togglePlayback}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-md px-3 text-[13px] font-bold text-ink-2 hover:bg-white hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy-500 focus-visible:ring-offset-2"
          >
            <Icon name={playbackPaused ? 'play' : 'pause'} size={17} />
            <span>{playbackPaused ? 'Play slideshow' : 'Pause slideshow'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default HospitalityCarousel;
