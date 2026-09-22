# Design System: PicFind

## 1. Visual Theme & Atmosphere

A photography studio meets a precise personal library. Gallery-airy, confidently asymmetric, with chrome optics, translucent teal glass, and a silver studio canvas. Density 4, variance 7, motion 2. Stitch reference: project 15658961930722475220, screen 4daf30a112014f4ba4bed63ea0dcebfa. Preserve original PicFind branding. The rendered asset is an illustration, not customer photography or a functional product screenshot.

## 2. Color Palette & Roles

Canvas #FAFAFA, surface #FFFFFF, charcoal ink #202427, secondary #60676A, border #E4E7E7. Single desaturated teal accent #246D70 on the landing page and established #287F83 in the workspace. Cool silver #E6EDED for sculptural surfaces. Logo may retain original supplied asset colors. No pure black, purple or neon.

## 3. Typography Rules

Self-hosted Manrope variable for display and body to preserve PicFind identity. Display tracking -0.06em with clamp(2.8rem,6vw,5.8rem). Body 16px line-height 1.65 and 65ch maximum. Metadata monospace. No Inter or dashboard serif.

## 4. Component Stylings

Rounded 12px tactile buttons, 44px minimum targets; outline secondary actions. Rounded 24px gallery compositions with delicate borders. Persistent labels above fields, inline errors below. Real empty states, shimmer skeletons, no fake metrics or fake photos as user data. Photo detail native dialog; selected photos have teal border.

## 5. Layout Principles

1280px centered container, left-aligned asymmetric hero with a static studio artwork. Numbered feature rows with alternating placement, sculptural sharing illustration, sourced comparison, native FAQ, final CTA. Authenticated library: established sidebar, toolbar, spacious gallery, sticky selection controls. Two-column mobile photos, single column on very narrow screens. All editorial multi-column layouts collapse below 768px. Navigation collapses with an accessible menu. No horizontal overflow.

## 6. Motion & Interaction

Static 3D-style WebP artwork and CSS glass surfaces are the default. The landing page does not load WebGL or an animation engine. No scroll hijacking, pointer tracking, or perpetual animation. Respect reduced motion. Lazy gallery images, asynchronous decoding, bounded cancellable ZIP generation with fflate loaded only on demand. Photo detail supports keyboard arrows and swipe gestures.

## 7. Anti-Patterns (Banned)

No emoji, Inter, pure black, neon shadows, gradient text, invented customer data, fictional analytics, fake testimonials, unsupported accuracy guarantees, or claims that unavailable integrations are complete. Describe selfie-search results as likely matches and similarity, not guaranteed identity. Never imply that scores are independent accuracy measurements. Drive is a read-only source; downloads go to the user's device, not back to Drive. Clearly distinguish preview limits and future paid plans.

## September 21 Studio evolution

Stitch project 15658961930722475220 supplied the photo-discovery illustration and public/Studio direction. Local artwork is a roughly 25 KB WebP; original generated evidence stays under ignored artifacts/design. The hero uses shallow compositor-only scroll transforms and disables motion for reduced-motion users. No PlayCanvas runtime is loaded.

Public navigation uses anchored Discover, Events, Pricing and FAQ sections. Studio is an authenticated application shell with a sidebar, separate header/footer, real data overview and a dedicated photo library route. Glass surfaces use high-opacity backgrounds for readability, with stronger contrast on text and useful focus targets. Overlap is confined to decorative art; controls and body text never overlap.

Pricing remains explicit about activation state until the billing phase connects real allowances. Comparison copy explains PicFind's dual existing-collection discovery and organizer delivery, without claiming that competitors lack unverified features. Generated illustration scores are labeled illustrative, not measured product accuracy.
