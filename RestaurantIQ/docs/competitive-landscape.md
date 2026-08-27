# Competitive Landscape

> Current as of August 2026. Focused on Toast, the reference point every
> restaurant operator compares a menu-analytics product against. Sources are
> listed at the bottom; all figures are Toast's own published or internal
> numbers unless noted, so treat vendor-reported lifts as marketing claims.

## Why Toast is the benchmark, not the competitor

Toast is a POS company that sells analytics as an attachment to its own
terminals. RestaurantIQ is analytics over **someone else's** POS (Square) plus a
delivery channel (DoorDash). We do not compete for the same purchase decision -
a restaurant does not choose between "Toast" and "RestaurantIQ."

What Toast does define is the **expectation**: when an operator hears "menu
analytics," Toast's feature set is the mental model. That makes it the bar for
what our dashboard has to cover, and the thing our positioning has to be
different from rather than worse at.

## What Toast actually shipped

Item-level menu reporting - product mix, menu engineering, dayparts, item
margin - has been in Toast POS **for years**. It is not new. What changed in
2025-26 is an AI layer on top of it plus network-scale benchmarking.

- **Toast IQ - conversational AI assistant** *(launched Oct 2025, expanded
  Spring 2026)*. Operators ask questions in chat instead of reading reports.
  Toast's Q1 2026 usage data: 179,000+ users, 125,000+ locations analyzed.
  Prompt mix - sales/revenue 47%, **menu and inventory 34%**, guest/marketing
  32%, operations/reporting 29%. The single most common prompt was *"Create a
  short, easy-to-read daily briefing for my restaurant."*
- **Toast IQ Actions** *(Spring Release 2026, May 2026)*. The assistant moved
  from read to **write** - it can change prices, upsell prompts, and item
  availability from the chat. It also reads across locations (cross-location
  item sales, labor trends) and replies in the operator's language.
- **Menu Upsells**. Toast IQ analyzes sales data to recommend pairings, surfaced
  live on handhelds, terminals, kiosks, and guest-facing displays. Toast claims
  checks with a converted upsell run 35%+ higher *(internal data, 1/1-3/17/2026,
  checks over $5)*.
- **Toast Benchmarking** *(announced Apr 2024, rolling out to select users)*. An
  AI classification model normalizes ~70M unique menu items into standard
  categories so a restaurant can compare its own category performance against
  aggregated Toast restaurants - filterable by location radius, day, week,
  month, and preceding period.
- **Menu Price Monitor** *(May 2025)*. The public-facing spinoff of
  Benchmarking: monthly median / 25th / 75th percentile menu pricing for
  burgers, wings, beer, cold brew, burritos, coffee, with YoY deltas. This is
  marketing content, not a product feature - but it is very effective marketing
  content.
- **Menu Item Review**. Guests paying via receipt QR optionally rate individual
  items; the restaurant gets a weekly summary email. Sentiment attached to
  item-level sales data.

## What this means for us

Three read-outs, in order of how much they should change what we build.

- **The AI-insights bet is validated, not obsoleted.** 34% of Toast IQ prompts
  are menu/inventory and the top prompt is a daily briefing. That is
  substantially our "plain English recommendations on what to promote, cut, or
  reprice." Toast proved the demand at 125k locations; it does not foreclose it
  for a Square restaurant.
- **Do not build a benchmarking story.** Toast's comparison-against-peers
  feature rests on 140k+ locations and 70M menu items. That is a data-scale
  asset, not a feature - it cannot be copied by a smaller product, and
  attempting a thin version of it would be a credibility liability rather than a
  differentiator.
- **The gap we own is cross-source.** Toast's analytics are Toast-only. A
  restaurant running Square in-house *plus* DoorDash has no unified item-level
  view of the same menu item across both channels, and Toast has no incentive to
  build one. The 2026 releases do not touch this. Our `menu_items.source` enum
  (`toast` / `doordash` / `manual`) already anticipates the multi-source shape;
  this is the origin-story gap the public positioning leads with.

## The idea worth stealing

The most-used AI surface at restaurant scale is not a dashboard - it is a
**short daily briefing**. Toast's most common prompt, across 179k users, is a
request for one. Worth weighing against another chart the next time alerts or
AI-insight surfaces come up for sprint scope.

## Sources

- [Toast Spring Release 2026](https://pos.toasttab.com/innovation-hub/spring-2026)
- [90 Days with Toast IQ (BusinessWire, Jun 2026)](https://www.businesswire.com/news/home/20260610036506/en/90-Days-with-Toast-IQ-How-Restaurant-Operators-Are-Using-Toast-IQ-to-Find-Time-Protect-Margins-and-Grow)
- [Margin Protection Emerges as Top Use Case for Toast IQ (Food On Demand)](https://foodondemand.com/06102026/margin-protection-emerges-as-top-use-case-for-toast-iq/)
- [Toast Launches Menu Price Monitor](https://pos.toasttab.com/news/toast-launches-menu-price-monitor)
- [Toast Reporting & Analytics](https://pos.toasttab.com/products/reporting)
- [Toast to Add AI-Based Benchmarking (PYMNTS)](https://www.pymnts.com/restaurant-technology/2024/toast-to-add-ai-based-benchmarking-feature-to-restaurant-management-suite/)
- [Toast Launches Conversational AI Assistant (Restaurant Technology News)](https://restauranttechnologynews.com/2025/10/toast-launches-conversational-ai-assistant-to-help-restaurant-operators-work-faster-and-smarter/)
- [Toast Debuts Toast IQ Grow (BusinessWire)](https://www.businesswire.com/news/home/20260505034143/en/Toast-Debuts-Toast-IQ-Grow-to-Take-On-Marketing-and-Drive-Demand-for-Operators)
