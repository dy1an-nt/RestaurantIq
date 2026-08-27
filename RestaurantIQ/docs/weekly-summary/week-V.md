# Week V: Landing-page hospitality carousel

## Sprint goal in one sentence

Replace the hero's product screenshot with an accessible hospitality carousel that gives the landing page a stronger restaurant context without weakening motion preferences, product honesty, or asset provenance.

## What shipped, in plain English

- The landing hero now rotates through three brand-reviewed restaurant, cafe, and bar interiors.
- Visitors can choose a slide, move backward or forward, and pause or resume the slideshow with labeled controls.
- Autoplay pauses for hover, keyboard focus, reduced-motion preferences, and hidden browser tabs.
- The real RestaurantIQ dashboard screenshot moved into the Analytics section, so product evidence remains on the page instead of competing with the hero.
- Every photograph has an illustrative caption, source credit, documented crop, and rights-review note.

## File-by-file

- `restaurantiq-frontend/src/components/HospitalityCarousel.tsx` is the carousel itself. It owns slide selection, the six-second timer, pause precedence, keyboard controls, visibility handling, reduced-motion handling, captions, and accessible labels.
- `restaurantiq-frontend/src/components/Icons.tsx` adds `play` and `pause` to the shared icon set so the controls match the existing visual language.
- `restaurantiq-frontend/src/pages/Landing.tsx` places the carousel in the hero and moves the real dashboard screenshot below the Analytics charts. This separates hospitality mood-setting from product proof.
- `restaurantiq-frontend/src/assets/landing/restaurant-interior.webp` is the first, eagerly loaded restaurant image.
- `restaurantiq-frontend/src/assets/landing/cafe-interior.webp` is the lazily loaded, brand-free replacement for the rejected cafe image.
- `restaurantiq-frontend/src/assets/landing/bar-interior.webp` is the lazily loaded bar and cafe image.
- `restaurantiq-frontend/src/assets/landing/README.md` records each source page, photographer, original dimensions, crop, resize, WebP conversion, and rights caveat.
- `docs/bugs.md` records bug 18, where a licensed image still contained visible venue branding and could imply an endorsement.
- `docs/sharp-edges.md` turns that incident into a reusable review rule for future marketing assets.
- `docs/weekly-summary/week-V.md` is the public teaching handoff for the sprint.

## Key technical decisions

### Explicit user intent has precedence, except when the document is hidden

**Context.** Autoplay should pause when a visitor hovers, moves keyboard focus into the carousel, or requests reduced motion. Those same safeguards can conflict with someone deliberately pressing Play.

**Decision.** The effective rule is:

1. A hidden document always pauses.
2. An explicit Pause always pauses.
3. An explicit Play overrides hover, focus, and the current reduced-motion pause.
4. Without an explicit override, hover, focus, or reduced motion pauses autoplay.

If the operating-system motion preference changes to reduced motion while the page is open, the component clears the earlier Play override and pauses again. That treats a new system preference as newer user intent. Manual slide navigation increments a counter that recreates the interval, giving the selected slide a fresh six seconds instead of advancing immediately on an old timer.

**Why.** Hover and focus are useful default safeguards, but they are indirect signals. A click on Play is direct intent. Page visibility is different: advancing an unseen carousel wastes work and can return the visitor to an unexpected slide, so Play never overrides `document.hidden`.

**Subtle bug we hit.** QA found that Play could appear to do nothing. Clicking the button moves focus inside the carousel, and the focus pause immediately defeated playback. The fix introduced `userForcedPlayback` and made that explicit state override interaction pauses. The broader lesson is that related boolean flags need a documented precedence rule. Adding one more condition to a large `paused` expression is not enough when event handlers can activate several flags during one click.

### Keep the carousel accessible without adding a dependency

**Context.** A carousel library would supply more features, but this interaction only needs three slides and a small state machine.

**Decision.** Use React state and browser APIs directly: `matchMedia`, `visibilitychange`, one managed interval, Arrow Left and Arrow Right handlers, semantic figures, and labeled buttons. Inactive slides use both `hidden` and `aria-hidden`; the container and slides identify themselves as a carousel and slides to assistive technology.

**Why.** The custom component stays small, follows RestaurantIQ's existing icon and Tailwind systems, and avoids adding package weight for behavior the browser already provides. The tradeoff is that we own interaction regression testing.

### Treat stock photography as a content supply-chain decision

**Context.** The first cafe candidate was free to use under its stock-photo license but visibly showed a venue name, logo, and branded publications.

**Decision.** Reject the image, replace it with a brand-free interior, inspect the final crop at full resolution, label the photos as illustrative, and keep a source and transformation manifest beside the assets.

**Why.** Permission to copy a photograph does not automatically clear trademarks, recognizable artwork, property or model rights, or the risk of implying endorsement. The security lesson is broader than copyright: third-party content needs provenance and inspection just like a software dependency. A valid source does not guarantee that the final artifact is safe for our use.

## Patterns and concepts you used

- **State-machine precedence.** The carousel has several inputs that can request the same output state. Encoding which signal wins is a small finite-state-machine problem, even though the implementation uses React booleans.
- **Effect cleanup.** Media-query listeners, visibility listeners, and intervals are registered in `useEffect` and removed during cleanup. This prevents duplicate timers and stale listeners during remounts.
- **Progressive loading.** The first image is eager because it is visible in the hero. Later slides are lazy, so they do not compete as strongly with the initial page render.
- **Asset provenance.** The manifest records where each image came from and how it changed. This is the content equivalent of preserving dependency metadata and a build recipe.
- **Progressive enhancement.** The page's message, links, captions, and manual controls remain useful without autoplay. Motion adds presentation, not access to information.

## Testing performed

- Frontend `npm run typecheck`: passed.
- Frontend `npm run lint`: passed with zero warnings.
- Frontend production Vite build: passed, with all three WebP files emitted as hashed assets. Vite repeated the existing warning that the main JavaScript chunk exceeds 500 KB.
- QA interaction review covered automatic advance, slide dots, previous and next controls, Arrow Left and Arrow Right, pause and resume, and hover and focus pauses. Reduced-motion and hidden-document precedence were verified in code because the browser harness could not dynamically emulate those states.
- QA's explicit Play test exposed the focus-precedence bug described above. The corrected behavior keeps playing after the Play button receives focus while still pausing whenever the document is hidden.
- The final image crops were reviewed for visible venue names, logos, branded publications, and identifiable people.

## Deployment implications

This is a frontend-only deployment. It requires no environment variables, database migrations, backend release, API contract change, or data backfill. The normal frontend build will fingerprint and publish the three WebP assets with the JavaScript and CSS. Their emitted size is about 281 KB combined, and only the first slide is marked eager. Rollback is the same as any static frontend rollback: redeploy the previous frontend artifact.

## What you should be able to explain in an interview

### 1. How did you decide which pause signal wins?

I treated the carousel controls as a precedence problem rather than a pile of independent booleans. A hidden tab is the hard stop because advancing unseen content wastes work and surprises the user on return. Explicit Pause also stops playback. Explicit Play is stronger than hover, focus, and the current reduced-motion pause because it is a direct action, while those are defaults inferred from context. QA proved why that distinction matters: clicking Play also focuses the button, so a naive focus rule immediately pauses the timer again. We fixed that with an explicit playback override. If the system's reduced-motion setting changes later, we clear the override because that new preference is the most recent intent.

### 2. Why build this without a carousel package?

The requirement was three images, one timer, manual controls, keyboard arrows, and predictable pause rules. React state plus `matchMedia`, `visibilitychange`, and `setInterval` cover that without introducing another dependency or styling system. The component also uses our existing icons and Tailwind tokens, so it fits the page. The tradeoff is ownership: a library might bring broader screen-reader conventions and more battle-tested gestures, while our version needs deliberate regression testing. For this narrow scope, the small implementation was easier to audit than a configurable package. I would revisit that choice if we added touch dragging, variable-width slides, dynamic content, or multiple carousels.

### 3. Why was a licensed stock image still rejected?

The license answered whether we could copy and modify the photograph. It did not answer whether the contents of the photograph were appropriate for RestaurantIQ marketing. The rejected image visibly included another venue's name, logo, and branded publications, which could imply that business endorsed or used the product. We replaced it, inspected the exact shipped crop, called the images illustrative, and recorded the source and transformation details beside the files. I think of this as content supply-chain review: provenance is necessary, but you still inspect the artifact. The same principle applies to fonts, icons, datasets, and generated media.

## What to look up if you want to go deeper

- [WAI-ARIA Authoring Practices carousel pattern](https://www.w3.org/WAI/ARIA/apg/patterns/carousel/) for expected roles, labels, rotation controls, and keyboard behavior.
- [WCAG 2.2 Success Criterion 2.2.2: Pause, Stop, Hide](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html) for moving content that starts automatically.
- [WCAG 2.2 Success Criterion 2.3.3: Animation from Interactions](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html) for respecting motion preferences.
- MDN references for [`Window.matchMedia`](https://developer.mozilla.org/en-US/docs/Web/API/Window/matchMedia) and the [Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API).
- [Pexels license](https://www.pexels.com/license/) as the starting point, not the end, of image-rights review.

## Things you punted

- **Automated carousel behavior tests.** The frontend still has no component-test harness, so timer and focus precedence are protected by manual QA rather than fake-timer tests.
- **Responsive image variants.** Each slide ships as one 1600 by 1000 WebP. There is no `srcset` for smaller screens yet.
- **Touch swipe gestures.** Mobile users have large manual controls, but the component does not implement drag or swipe navigation.
- **Main-bundle code splitting.** The production build still warns about a JavaScript chunk above 500 KB; this sprint did not change the application's chunking strategy.
