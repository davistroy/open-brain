import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
  ],

  theme: {
    extend: {
      // -----------------------------------------------------------------------
      // Colors — all mapped to CSS custom properties from globals.css / colors_and_type.css
      // Use as: text-ink, bg-parchment, border-book-cloth, etc.
      // -----------------------------------------------------------------------
      colors: {
        // ---- Anthropic core neutrals ----------------------------------------
        'ivory-light':   'var(--color-ivory-light)',
        'ivory-medium':  'var(--color-ivory-medium)',
        'ivory-dark':    'var(--color-ivory-dark)',
        'manilla':       'var(--color-manilla)',
        'cloud-light':   'var(--color-cloud-light)',
        'cloud-medium':  'var(--color-cloud-medium)',
        'cloud-dark':    'var(--color-cloud-dark)',
        'slate-light':   'var(--color-slate-light)',
        'slate-medium':  'var(--color-slate-medium)',
        'slate-dark':    'var(--color-slate-dark)',

        // Shorthand aliases used in components
        'ink':           'var(--color-slate-medium)',   // default text
        'parchment':     'var(--color-ivory-medium)',   // primary canvas

        // ---- Accents --------------------------------------------------------
        'book-cloth':         'var(--color-book-cloth)',
        'book-cloth-dark':    'var(--color-book-cloth-dark)',
        'book-cloth-darker':  'var(--color-book-cloth-darker)',
        'book-cloth-50':      'var(--color-book-cloth-50)',
        'book-cloth-100':     'var(--color-book-cloth-100)',

        // ---- Earth tones (html scope in source) -----------------------------
        'kraft':        'var(--color-kraft)',
        'kraft-50':     'var(--color-kraft-50)',
        'faded-red':    'var(--color-faded-red)',
        'faded-red-50': 'var(--color-faded-red-50)',
        'clay':         'var(--color-clay)',
        'moss':         'var(--color-moss)',
        'moss-50':      'var(--color-moss-50)',
        'sienna':       'var(--color-sienna)',
        'olive':        'var(--color-olive)',
        'olive-50':     'var(--color-olive-50)',

        // ---- Semantic success (new token, plan §Design Decisions) -----------
        'success':      'var(--color-success)',

        // ---- Semantic status pill/badge tokens ------------------------------
        'status-success-bg':     'var(--color-status-success-bg)',
        'status-success-fg':     'var(--color-status-success-fg)',
        'status-success-border': 'var(--color-status-success-border)',
        'status-warning-bg':     'var(--color-status-warning-bg)',
        'status-warning-fg':     'var(--color-status-warning-fg)',
        'status-warning-border': 'var(--color-status-warning-border)',
        'status-error-bg':       'var(--color-status-error-bg)',
        'status-error-fg':       'var(--color-status-error-fg)',
        'status-error-border':   'var(--color-status-error-border)',
        'status-accent-border':  'var(--color-status-accent-border)',

        // ---- Semantic surfaces & backgrounds --------------------------------
        'bg-layout-main':     'var(--color-bg-layout-main)',
        'bg-container':       'var(--color-bg-container)',
        'bg-dropdown':        'var(--color-bg-dropdown)',
        'bg-input':           'var(--color-bg-input)',
        'bg-item-selected':   'var(--color-bg-item-selected)',
        'bg-home-header':     'var(--color-bg-home-header)',
        'bg-status-info':     'var(--color-bg-status-info)',
        'bg-status-success':  'var(--color-bg-status-success)',
        'bg-status-warning':  'var(--color-bg-status-warning)',
        'bg-status-error':    'var(--color-bg-status-error)',
        'bg-cell-shaded':     'var(--color-bg-cell-shaded)',

        // ---- Semantic text --------------------------------------------------
        'text-body':                'var(--color-text-body)',
        'text-body-secondary':      'var(--color-text-body-secondary)',
        'text-heading':             'var(--color-text-heading)',
        'text-heading-secondary':   'var(--color-text-heading-secondary)',
        'text-small':               'var(--color-text-small)',
        'text-form-secondary':      'var(--color-text-form-secondary)',
        'text-disabled':            'var(--color-text-disabled)',
        'text-interactive':         'var(--color-text-interactive)',
        'text-interactive-hover':   'var(--color-text-interactive-hover)',
        'text-link':                'var(--color-text-link)',
        'text-link-hover':          'var(--color-text-link-hover)',
        'text-accent':              'var(--color-text-accent)',
        'text-status-success':      'var(--color-text-status-success)',
        'text-status-warning':      'var(--color-text-status-warning)',
        'text-status-error':        'var(--color-text-status-error)',
        'text-status-info':         'var(--color-text-status-info)',
        'text-counter':             'var(--color-text-counter)',
        'text-label-genai':         'var(--color-text-label-genai)',

        // ---- Semantic borders -----------------------------------------------
        'border-divider':          'var(--color-border-divider)',
        'border-divider-secondary':'var(--color-border-divider-secondary)',
        'border-input':            'var(--color-border-input)',
        'border-input-focused':    'var(--color-border-input-focused)',
        'border-control':          'var(--color-border-control)',
        'border-item-selected':    'var(--color-border-item-selected)',
        'border-status-info':      'var(--color-border-status-info)',
        'border-status-success':   'var(--color-border-status-success)',
        'border-status-warning':   'var(--color-border-status-warning)',
        'border-status-error':     'var(--color-border-status-error)',

        // ---- Button semantics -----------------------------------------------
        'button-primary-bg':       'var(--color-button-primary-bg)',
        'button-primary-bg-hover': 'var(--color-button-primary-bg-hover)',
        'button-primary-text':     'var(--color-button-primary-text)',
        'button-normal-bg':        'var(--color-button-normal-bg)',
        'button-normal-border':    'var(--color-button-normal-border)',
        'button-normal-text':      'var(--color-button-normal-text)',
        'button-normal-bg-hover':  'var(--color-button-normal-bg-hover)',

        // ---- Chart palette --------------------------------------------------
        'chart-1': 'var(--color-chart-1)',
        'chart-2': 'var(--color-chart-2)',
        'chart-3': 'var(--color-chart-3)',
        'chart-4': 'var(--color-chart-4)',
        'chart-5': 'var(--color-chart-5)',
        'chart-6': 'var(--color-chart-6)',
      },

      // -----------------------------------------------------------------------
      // Font families — mapped to CSS custom properties
      // Use as: font-sans, font-mono, font-display
      // -----------------------------------------------------------------------
      fontFamily: {
        // Tailwind's default `sans` → Inter (matches --font-family-base)
        sans:    ['var(--font-family-base)', 'Inter', '-apple-system', 'BlinkMacSystemFont', 'Helvetica Neue', 'Arial', 'sans-serif'],
        // body alias — explicit for clarity in component classes
        body:    ['var(--font-family-base)', 'Inter', '-apple-system', 'BlinkMacSystemFont', 'Helvetica Neue', 'Arial', 'sans-serif'],
        // display → Space Grotesk (--font-family-display)
        display: ['var(--font-family-display)', 'Space Grotesk', 'Inter', '-apple-system', 'sans-serif'],
        // mono → JetBrains Mono (--font-family-monospace)
        mono:    ['var(--font-family-monospace)', 'JetBrains Mono', 'Menlo', 'Monaco', 'Courier New', 'monospace'],
      },

      // -----------------------------------------------------------------------
      // Box shadows — design-system tokens via CSS var references
      // Use as: shadow-container, shadow-dropdown, shadow-panel, shadow-sticky
      // -----------------------------------------------------------------------
      boxShadow: {
        'container':        'var(--shadow-container)',
        'container-active': 'var(--shadow-container-active)',
        'dropdown':         'var(--shadow-dropdown)',
        'panel':            'var(--shadow-panel)',
        'sticky':           'var(--shadow-sticky)',
        // card is defined as `none` in tokens — explicit so it overrides Tailwind default
        'card':             'var(--shadow-card)',
      },

      // -----------------------------------------------------------------------
      // Border radius — design system uses hard corners; add the container 2px token
      // Use as: rounded-container (2px). rounded-none and rounded-[2px] also work.
      // -----------------------------------------------------------------------
      borderRadius: {
        'container': 'var(--border-radius-container)',  // 2px
        'item':      'var(--border-radius-item)',        // 8px — for avatars, chips
        'badge':     'var(--border-radius-badge)',       // 4px
      },

      // -----------------------------------------------------------------------
      // Transition durations — from motion tokens
      // Use as: duration-fast, duration-moderate, duration-slow
      // -----------------------------------------------------------------------
      transitionDuration: {
        'fast':     'var(--motion-duration-fast)',      // 90ms
        'moderate': 'var(--motion-duration-moderate)',  // 135ms
        'slow':     'var(--motion-duration-slow)',      // 220ms
      },

      // -----------------------------------------------------------------------
      // Transition timing functions — from motion tokens
      // Use as: ease-responsive, ease-sticky, ease-expressive
      // -----------------------------------------------------------------------
      transitionTimingFunction: {
        'responsive':  'var(--motion-easing-responsive)',
        'sticky':      'var(--motion-easing-sticky)',
        'expressive':  'var(--motion-easing-expressive)',
        'ease-out-quart': 'var(--motion-easing-ease-out-quart)',
      },

      // -----------------------------------------------------------------------
      // Keyframes + animation — spin-slow for loading states, fade-in for panels
      // No animations specified in tokens, but plan mentions animation tokens.
      // -----------------------------------------------------------------------
      keyframes: {
        'fade-in': {
          '0%':   { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-up': {
          '0%':   { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in-right': {
          '0%':   { opacity: '0', transform: 'translateX(8px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
      },
      animation: {
        // Use motion token durations + responsive easing
        'fade-in':        'fade-in 135ms cubic-bezier(0.2,0,0,1) both',
        'fade-up':        'fade-up 220ms cubic-bezier(0.2,0,0,1) both',
        'slide-in-right': 'slide-in-right 135ms cubic-bezier(0.2,0,0,1) both',
      },
    },
  },

  plugins: [],
}

export default config
