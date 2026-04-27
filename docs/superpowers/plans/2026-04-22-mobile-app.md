# Open Brain Mobile App — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a React Native (Expo Router SDK 53) mobile app as `packages/mobile` in the monorepo, implementing all 11 screens from the mobile design system with voice capture as the critical path.

**Architecture:** Expo managed workflow with file-based routing (Expo Router v4). Server-first — all data flows through core-api at `brain.troy-davis.com`. Audio recording via `expo-av`, uploaded to voice-capture service (port 3001) for batch Whisper transcription. Types declared locally (web-next pattern) — never import from `@open-brain/shared` (its barrel export bundles Node.js-only deps that Metro can't resolve). TanStack React Query v5 for data fetching.

**Tech Stack:** Expo SDK 53, Expo Router v4, React Native 0.76+, TypeScript, expo-av, expo-font, expo-secure-store, expo-haptics, expo-blur, expo-linear-gradient, @tanstack/react-query v5, lucide-react-native, react-native-reanimated, react-native-svg.

**Design reference:** `reference/handoff/open-brain-cloudscape-design-system/project/mobile/` — 11 JSX files (M1-M11) + `_mobile-shell.jsx` + `colors_and_type.css` for tokens.

---

## Critical decisions from ultra-plan investigation

| Decision | Detail |
|----------|--------|
| **No @open-brain/shared dep** | Barrel export bundles pg, drizzle-orm, pino, msal-node, node:fs. Metro can't resolve. Types declared locally in `src/lib/types.ts` (same pattern as `packages/web-next/lib/types.ts`). |
| **Voice uploads → voice-capture:3001** | `POST /api/capture`, multipart field `file` (not `audio`). Returns `{ ok, capture, transcription, classification }`. NOT core-api. |
| **Batch transcript only** | No streaming/real-time transcription exists. M2 recording screen shows waveform + timer during recording, then "Transcribing..." spinner after stop, then navigates to M3 confirm with the result. |
| **Rate-limit bypass** | Mobile must send `X-Open-Brain-Caller: mobile-app` header. Add `'internal:mobile-app'` to BYPASS_CALLERS in `packages/core-api/src/middleware/rate-limit.ts:181`. |
| **Tailscale access** | Voice-capture not proxied through nginx. Mobile hits Tailscale IP directly (same as iOS Shortcut pattern). |

---

## File structure

```
packages/mobile/
├── app.json
├── package.json
├── tsconfig.json
├── babel.config.js
├── metro.config.js
├── .gitignore
├── app/
│   ├── _layout.tsx                 — Root layout: fonts, QueryClient, ThemeProvider
│   ├── (tabs)/
│   │   ├── _layout.tsx             — Tab navigator with custom TabBar
│   │   ├── index.tsx               — Home screen (M1)
│   │   ├── briefs.tsx              — Briefs list (M4)
│   │   ├── board.tsx               — Board (M7)
│   │   └── library.tsx             — Timeline/Library (M8)
│   ├── record.tsx                  — Recording screen (M2) — modal
│   ├── confirm.tsx                 — Capture confirm (M3)
│   ├── briefs/
│   │   └── [id].tsx                — Brief reader (M5)
│   ├── entities/
│   │   └── [id].tsx                — Entity dossier (M6)
│   ├── search.tsx                  — Search modal (M9)
│   ├── settings.tsx                — Settings (M10)
│   └── onboarding.tsx              — First-run empty (M11)
├── src/
│   ├── theme/
│   │   ├── tokens.ts               — Raw color palette from colors_and_type.css
│   │   ├── theme.ts                — Light/dark objects + ThemeProvider + useTheme
│   │   ├── typography.ts           — Named text style presets
│   │   └── spacing.ts              — 4px grid scale
│   ├── components/
│   │   ├── shell/
│   │   │   ├── TabBar.tsx          — Custom bottom tab bar with elevated mic hero
│   │   │   └── TopBar.tsx          — Screen header: eyebrow + title + actions
│   │   ├── primitives/
│   │   │   ├── MCard.tsx           — Card container (white/dark, hairline border)
│   │   │   ├── MPill.tsx           — Tone-aware badge pill
│   │   │   ├── MEyebrow.tsx        — Mono uppercase section label
│   │   │   ├── MButton.tsx         — Primary/ghost button
│   │   │   ├── Hairline.tsx        — StyleSheet.hairlineWidth separator
│   │   │   ├── IconBox.tsx         — Square icon container
│   │   │   ├── SectionHeader.tsx   — Label + optional "→" link
│   │   │   └── ListRow.tsx         — Icon + title + sub + right accessory + divider
│   │   ├── capture/
│   │   │   ├── HeroRecordButton.tsx — Concentric rings + gradient mic button
│   │   │   ├── QuickCaptureGrid.tsx — 3-column Note/Photo/Link
│   │   │   ├── Waveform.tsx        — Animated recording bars
│   │   │   └── RecordControls.tsx  — Restart/stop/confirm bar
│   │   ├── briefs/
│   │   │   ├── BriefListItem.tsx   — Kind + title + meta + progress bar
│   │   │   └── DropCap.tsx         — Floating first letter for reader
│   │   ├── entity/
│   │   │   ├── EntityHero.tsx      — Avatar + kind + name + stats
│   │   │   └── StatsGrid.tsx       — 3-column stat boxes
│   │   ├── board/
│   │   │   ├── ColumnTabs.tsx      — Open/Pondering/Decided tabs
│   │   │   └── DecisionCard.tsx    — Priority rail + title + meta + actions
│   │   ├── search/
│   │   │   ├── SearchBar.tsx       — Input with hit count + cancel
│   │   │   └── ScopeChips.tsx      — Filter row
│   │   └── settings/
│   │       ├── SettingsSection.tsx  — Mono label + grouped card
│   │       ├── SettingsRow.tsx      — Icon + title + sub + accessory
│   │       └── Toggle.tsx          — Terracotta iOS toggle
│   ├── lib/
│   │   ├── types.ts                — Local type declarations (mirrors API shapes)
│   │   ├── api-client.ts           — Typed HTTP client (web-next pattern)
│   │   ├── audio.ts                — expo-av recording + upload to voice-capture
│   │   ├── config.ts               — API base URL, voice-capture URL
│   │   └── storage.ts              — expo-secure-store wrapper
│   └── hooks/
│       ├── useCaptures.ts          — TanStack Query: list, create
│       ├── useBriefs.ts            — TanStack Query: list, detail
│       ├── useEntities.ts          — TanStack Query: list, detail
│       ├── useSearch.ts            — TanStack Query: search
│       ├── useCommitments.ts       — TanStack Query: list, patch
│       └── useRecording.ts         — Audio state machine: idle → recording → uploading → done
└── __tests__/
    ├── theme/
    │   └── tokens.test.ts
    ├── lib/
    │   └── api-client.test.ts
    └── components/
        ├── TabBar.test.tsx
        └── MPill.test.tsx
```

---

## Task 1: Scaffold Expo Router project

**Files:**
- Create: `packages/mobile/package.json`
- Create: `packages/mobile/tsconfig.json`
- Create: `packages/mobile/app.json`
- Create: `packages/mobile/babel.config.js`
- Create: `packages/mobile/metro.config.js`
- Create: `packages/mobile/.gitignore`
- Verify: `pnpm-workspace.yaml` (already has `packages/*` glob — no change needed)

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@open-brain/mobile",
  "version": "0.1.0",
  "private": true,
  "main": "expo-router/entry",
  "scripts": {
    "start": "expo start",
    "ios": "expo run:ios",
    "android": "expo run:android",
    "test": "jest",
    "lint": "tsc --noEmit"
  },
  "dependencies": {
    "@expo-google-fonts/inter": "^0.2.3",
    "@expo-google-fonts/jetbrains-mono": "^0.2.3",
    "@expo-google-fonts/space-grotesk": "^0.2.3",
    "@tanstack/react-query": "^5.62.0",
    "expo": "~53.0.0",
    "expo-av": "~15.0.0",
    "expo-blur": "~14.0.0",
    "expo-font": "~13.0.0",
    "expo-haptics": "~14.0.0",
    "expo-linear-gradient": "~14.0.0",
    "expo-router": "~4.0.0",
    "expo-secure-store": "~14.0.0",
    "expo-splash-screen": "~0.29.0",
    "expo-status-bar": "~2.0.0",
    "lucide-react-native": "^0.468.0",
    "react": "18.3.1",
    "react-native": "0.76.7",
    "react-native-reanimated": "~3.16.0",
    "react-native-safe-area-context": "~4.14.0",
    "react-native-screens": "~4.4.0",
    "react-native-svg": "~15.11.0"
  },
  "devDependencies": {
    "@testing-library/react-native": "^12.9.0",
    "@types/jest": "^29.5.14",
    "@types/react": "~18.3.12",
    "jest": "^29.7.0",
    "jest-expo": "~53.0.0",
    "typescript": "~5.7.0"
  }
}
```

**CRITICAL:** No `@open-brain/shared` dependency. Types declared locally in `src/lib/types.ts`.

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "extends": "expo/tsconfig.base",
  "compilerOptions": {
    "strict": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  },
  "include": ["**/*.ts", "**/*.tsx", ".expo/types/**/*.ts", "expo-env.d.ts"]
}
```

- [ ] **Step 3: Create app.json**

```json
{
  "expo": {
    "name": "Open Brain",
    "slug": "open-brain-mobile",
    "version": "0.1.0",
    "orientation": "portrait",
    "icon": "./assets/icon.png",
    "scheme": "openbrain",
    "userInterfaceStyle": "automatic",
    "newArchEnabled": true,
    "ios": {
      "supportsTablet": false,
      "bundleIdentifier": "com.openbrain.mobile",
      "infoPlist": {
        "NSMicrophoneUsageDescription": "Open Brain uses the microphone to record voice captures."
      }
    },
    "android": {
      "adaptiveIcon": {
        "foregroundImage": "./assets/adaptive-icon.png",
        "backgroundColor": "#F0EEE6"
      },
      "package": "com.openbrain.mobile",
      "permissions": ["RECORD_AUDIO"]
    },
    "plugins": [
      "expo-router",
      "expo-font",
      "expo-secure-store",
      [
        "expo-av",
        {
          "microphonePermission": "Open Brain needs microphone access to record voice captures."
        }
      ]
    ]
  }
}
```

- [ ] **Step 4: Create babel.config.js**

```js
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: ['react-native-reanimated/plugin'],
  };
};
```

- [ ] **Step 5: Create metro.config.js**

```js
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

module.exports = config;
```

- [ ] **Step 6: Create .gitignore**

```
node_modules/
.expo/
dist/
*.jks
*.p8
*.p12
*.key
*.mobileprovision
*.orig.*
web-build/
ios/
android/
```

- [ ] **Step 7: Create placeholder assets directory**

Run: `mkdir -p packages/mobile/assets`

Create a minimal `packages/mobile/assets/icon.png` (1024x1024) and `packages/mobile/assets/adaptive-icon.png` (1024x1024). For now, copy any square PNG or generate a placeholder:

Run: `convert -size 1024x1024 xc:'#F0EEE6' -fill '#CC785C' -gravity center -pointsize 200 -annotate 0 'OB' packages/mobile/assets/icon.png && cp packages/mobile/assets/icon.png packages/mobile/assets/adaptive-icon.png`

If `convert` (ImageMagick) isn't available, create any 1024x1024 PNG manually and place both files. The app won't build without them.

- [ ] **Step 8: Install dependencies and verify project starts**

Run: `cd packages/mobile && pnpm install`
Expected: Clean install, no workspace link errors.

Run: `cd packages/mobile && npx expo start --clear`
Expected: Expo dev server starts. Press `q` to quit. (Don't need it running yet — just verify the scaffold is valid.)

- [ ] **Step 9: Commit**

```bash
git add packages/mobile/
git commit -m "feat(mobile): scaffold Expo Router project in monorepo"
```

---

## Task 2: Theme module — tokens, spacing, typography, light/dark themes

**Files:**
- Create: `packages/mobile/src/theme/tokens.ts`
- Create: `packages/mobile/src/theme/spacing.ts`
- Create: `packages/mobile/src/theme/typography.ts`
- Create: `packages/mobile/src/theme/theme.ts`
- Test: `packages/mobile/__tests__/theme/tokens.test.ts`

**Design source:** `reference/handoff/.../colors_and_type.css` lines 36-55 (palette), `_mobile-shell.jsx` lines 24-27 (dark mode semantic mapping). Every mobile screen uses the same 5 semantic colors: `ink`, `body`, `secondary`, `hairline`, `cardBg`.

- [ ] **Step 1: Write the theme drift test**

```typescript
// __tests__/theme/tokens.test.ts
import { lightTheme, darkTheme } from '../../src/theme/theme';

describe('theme tokens', () => {
  const requiredColorKeys = [
    'ink', 'body', 'secondary', 'hairline', 'cardBg', 'bg',
    'accent', 'accentDark', 'accentDarker', 'accentLight', 'accentLighter',
    'tabBarBg', 'tabBarBorder',
    'iconBg', 'successText', 'warnText',
  ];

  test('light theme has all required semantic colors', () => {
    for (const key of requiredColorKeys) {
      expect(lightTheme.colors).toHaveProperty(key);
      expect(typeof (lightTheme.colors as Record<string, string>)[key]).toBe('string');
    }
  });

  test('dark theme has all required semantic colors', () => {
    for (const key of requiredColorKeys) {
      expect(darkTheme.colors).toHaveProperty(key);
      expect(typeof (darkTheme.colors as Record<string, string>)[key]).toBe('string');
    }
  });

  test('light and dark themes have identical color key sets', () => {
    const lightKeys = Object.keys(lightTheme.colors).sort();
    const darkKeys = Object.keys(darkTheme.colors).sort();
    expect(lightKeys).toEqual(darkKeys);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/mobile && pnpm test -- __tests__/theme/tokens.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create tokens.ts**

```typescript
// src/theme/tokens.ts
export const palette = {
  ivoryLight:   '#FAFAF7',
  ivoryMedium:  '#F0EEE6',
  ivoryDark:    '#E8E6DB',
  manilla:      '#EBDBBC',
  cloudLight:   '#E4E2DC',
  cloudMedium:  '#C2C0B6',
  cloudDark:    '#8F8E85',
  slateLight:   '#40403E',
  slateMedium:  '#262624',
  slateDark:    '#141413',

  bookCloth:       '#CC785C',
  bookClothDark:   '#B25A3D',
  bookClothDarker: '#8C3F28',
  bookCloth50:     '#FBEFE9',
  bookCloth100:    '#F2D5C6',

  kraft:     '#D4A27F',
  fadedRed:  '#BF4939',
  moss:      '#7A8471',
  moss50:    '#EEF1EC',
  olive:     '#5F5B3B',
  olive50:   '#EEEBDD',

  white:  '#FFFFFF',
  black:  '#000000',

  darkBg:        '#141413',
  darkBgDeep:    '#0E0E0D',
  darkCard:      '#1C1C1A',
  darkSurface:   '#262624',
  darkMuted:     '#3A3A36',
  darkInk:       '#F0EEE6',
  darkBody:      '#C2C0B6',
  darkBodyLight: '#D6D4CA',
  darkSecondary: '#8F8E85',
  darkInactive:  '#626260',
} as const;
```

- [ ] **Step 4: Create spacing.ts**

```typescript
// src/theme/spacing.ts
export const spacing = {
  xxs: 2,
  xs:  4,
  s:   8,
  m:   12,
  l:   16,
  xl:  20,
  xxl: 24,
  xxxl: 32,
  xxxxl: 40,
} as const;

export const contentPadding = { horizontal: 20, vertical: 18 } as const;
export const tabBarHeight = 80;
```

- [ ] **Step 5: Create typography.ts**

```typescript
// src/theme/typography.ts
import { TextStyle } from 'react-native';

export const fontFamilies = {
  display: 'SpaceGrotesk_400Regular',
  displayMedium: 'SpaceGrotesk_500Medium',
  displayBold: 'SpaceGrotesk_700Bold',
  body: 'Inter_400Regular',
  bodyMedium: 'Inter_500Medium',
  bodySemiBold: 'Inter_600SemiBold',
  mono: 'JetBrainsMono_400Regular',
  monoMedium: 'JetBrainsMono_500Medium',
} as const;

export const textStyles = {
  displayLarge: {
    fontFamily: fontFamilies.display,
    fontSize: 32,
    lineHeight: 35,
    letterSpacing: -0.025 * 32,
  } satisfies TextStyle,

  displayMedium: {
    fontFamily: fontFamilies.display,
    fontSize: 26,
    lineHeight: 29,
    letterSpacing: -0.02 * 26,
  } satisfies TextStyle,

  displaySmall: {
    fontFamily: fontFamilies.display,
    fontSize: 22,
    lineHeight: 26,
    letterSpacing: -0.015 * 22,
  } satisfies TextStyle,

  heading: {
    fontFamily: fontFamilies.displayMedium,
    fontSize: 20,
    lineHeight: 24,
    letterSpacing: -0.01 * 20,
  } satisfies TextStyle,

  title: {
    fontFamily: fontFamilies.display,
    fontSize: 18,
    lineHeight: 22,
    letterSpacing: -0.01 * 18,
  } satisfies TextStyle,

  body: {
    fontFamily: fontFamilies.body,
    fontSize: 14.5,
    lineHeight: 22,
  } satisfies TextStyle,

  bodySmall: {
    fontFamily: fontFamilies.body,
    fontSize: 13.5,
    lineHeight: 20,
  } satisfies TextStyle,

  bodyReader: {
    fontFamily: fontFamilies.body,
    fontSize: 16,
    lineHeight: 26,
  } satisfies TextStyle,

  label: {
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 14,
    lineHeight: 18,
  } satisfies TextStyle,

  eyebrow: {
    fontFamily: fontFamilies.mono,
    fontSize: 10,
    letterSpacing: 0.12 * 10,
    textTransform: 'uppercase',
  } satisfies TextStyle,

  meta: {
    fontFamily: fontFamilies.mono,
    fontSize: 11,
    letterSpacing: 0.02 * 11,
  } satisfies TextStyle,

  metaSmall: {
    fontFamily: fontFamilies.mono,
    fontSize: 10.5,
    letterSpacing: 0.04 * 10.5,
  } satisfies TextStyle,

  timer: {
    fontFamily: fontFamilies.mono,
    fontSize: 56,
    fontWeight: '300',
    letterSpacing: -0.02 * 56,
  } satisfies TextStyle,
} as const;
```

- [ ] **Step 6: Create theme.ts with light/dark themes and ThemeProvider**

```typescript
// src/theme/theme.ts
import React, { createContext, useContext, useMemo } from 'react';
import { useColorScheme } from 'react-native';
import { palette } from './tokens';
import { spacing, contentPadding, tabBarHeight } from './spacing';
import { textStyles, fontFamilies } from './typography';

const lightColors = {
  ink: palette.slateDark,
  body: palette.slateLight,
  secondary: palette.cloudDark,
  hairline: palette.cloudLight,
  cardBg: palette.white,
  bg: palette.ivoryMedium,

  accent: palette.bookCloth,
  accentDark: palette.bookClothDark,
  accentDarker: palette.bookClothDarker,
  accentLight: palette.bookCloth50,
  accentLighter: palette.bookCloth100,

  tabBarBg: 'rgba(240,238,230,0.92)',
  tabBarBorder: 'rgba(20,20,19,0.08)',

  iconBg: palette.ivoryMedium,
  successText: '#4A6B3A',
  warnText: '#8B6F3A',
};

const darkColors = {
  ink: palette.darkInk,
  body: palette.darkBody,
  secondary: palette.darkSecondary,
  hairline: 'rgba(240,238,230,0.08)',
  cardBg: palette.darkCard,
  bg: palette.darkBg,

  accent: palette.bookCloth,
  accentDark: palette.bookClothDark,
  accentDarker: palette.bookClothDarker,
  accentLight: palette.bookCloth50,
  accentLighter: palette.bookCloth100,

  tabBarBg: 'rgba(20,20,19,0.92)',
  tabBarBorder: 'rgba(240,238,230,0.08)',

  iconBg: palette.darkSurface,
  successText: '#9CB890',
  warnText: '#C9A66B',
};

export type ThemeColors = typeof lightColors;

export interface Theme {
  dark: boolean;
  colors: ThemeColors;
  spacing: typeof spacing;
  contentPadding: typeof contentPadding;
  tabBarHeight: number;
  text: typeof textStyles;
  fonts: typeof fontFamilies;
}

export const lightTheme: Theme = {
  dark: false,
  colors: lightColors,
  spacing,
  contentPadding,
  tabBarHeight,
  text: textStyles,
  fonts: fontFamilies,
};

export const darkTheme: Theme = {
  dark: true,
  colors: darkColors,
  spacing,
  contentPadding,
  tabBarHeight,
  text: textStyles,
  fonts: fontFamilies,
};

const ThemeContext = createContext<Theme>(lightTheme);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const colorScheme = useColorScheme();
  const theme = useMemo(
    () => (colorScheme === 'dark' ? darkTheme : lightTheme),
    [colorScheme],
  );
  return React.createElement(ThemeContext.Provider, { value: theme }, children);
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
```

- [ ] **Step 7: Run tests**

Run: `cd packages/mobile && pnpm test -- __tests__/theme/tokens.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 8: Commit**

```bash
git add packages/mobile/src/theme/ packages/mobile/__tests__/theme/
git commit -m "feat(mobile): theme module — tokens, typography, spacing, light/dark"
```

---

## Task 3: Root layout — fonts, QueryClient, ThemeProvider

**Files:**
- Create: `packages/mobile/app/_layout.tsx`

- [ ] **Step 1: Create root layout**

```tsx
// app/_layout.tsx
import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useFonts, Inter_400Regular, Inter_500Medium, Inter_600SemiBold } from '@expo-google-fonts/inter';
import { SpaceGrotesk_400Regular, SpaceGrotesk_500Medium, SpaceGrotesk_700Bold } from '@expo-google-fonts/space-grotesk';
import { JetBrainsMono_400Regular, JetBrainsMono_500Medium } from '@expo-google-fonts/jetbrains-mono';
import { ThemeProvider, useTheme } from '../src/theme/theme';

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 60_000, retry: 2 },
  },
});

function RootInner() {
  const theme = useTheme();

  return (
    <>
      <StatusBar style={theme.dark ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="record" options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }} />
        <Stack.Screen name="confirm" options={{ presentation: 'modal' }} />
        <Stack.Screen name="search" options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    SpaceGrotesk_400Regular,
    SpaceGrotesk_500Medium,
    SpaceGrotesk_700Bold,
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
  });

  useEffect(() => {
    if (fontsLoaded) SplashScreen.hideAsync();
  }, [fontsLoaded]);

  if (!fontsLoaded) return null;

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <RootInner />
      </ThemeProvider>
    </QueryClientProvider>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd packages/mobile && npx tsc --noEmit`
Expected: No errors (may have warnings about missing route files — that's OK, we'll create them next).

- [ ] **Step 3: Commit**

```bash
git add packages/mobile/app/_layout.tsx
git commit -m "feat(mobile): root layout with fonts, QueryClient, ThemeProvider"
```

---

## Task 4: Custom TabBar + tab layout

**Files:**
- Create: `packages/mobile/src/components/shell/TabBar.tsx`
- Create: `packages/mobile/app/(tabs)/_layout.tsx`
- Test: `packages/mobile/__tests__/components/TabBar.test.tsx`

**Design source:** `_mobile-shell.jsx` lines 29-146 — 4 tabs: Home (mic icon, elevated 44px circle with accent bg when active), Briefs (newspaper), Board (square-pen), Library (library). Frosted blur backdrop. Mono uppercase labels.

- [ ] **Step 1: Write TabBar test**

```tsx
// __tests__/components/TabBar.test.tsx
import React from 'react';
import { render } from '@testing-library/react-native';
import { TabBar } from '../../src/components/shell/TabBar';

jest.mock('expo-blur', () => ({
  BlurView: ({ children, ...props }: any) =>
    React.createElement('View', props, children),
}));

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(),
  ImpactFeedbackStyle: { Light: 'light' },
}));

jest.mock('lucide-react-native', () => ({
  Mic: (props: any) => React.createElement('View', { testID: 'icon-mic', ...props }),
  Newspaper: (props: any) => React.createElement('View', { testID: 'icon-newspaper', ...props }),
  SquarePen: (props: any) => React.createElement('View', { testID: 'icon-squarepen', ...props }),
  Library: (props: any) => React.createElement('View', { testID: 'icon-library', ...props }),
}));

const mockNavigation = { emit: jest.fn(() => ({ defaultPrevented: false })) } as any;
const mockState = {
  index: 0,
  routes: [
    { key: 'index-1', name: 'index' },
    { key: 'briefs-1', name: 'briefs' },
    { key: 'board-1', name: 'board' },
    { key: 'library-1', name: 'library' },
  ],
} as any;
const mockDescriptors = {} as any;

describe('TabBar', () => {
  test('renders 4 tab buttons', () => {
    const { getAllByRole } = render(
      <TabBar state={mockState} descriptors={mockDescriptors} navigation={mockNavigation} />,
    );
    // TabBar renders Pressable components — look for them
    const buttons = getAllByRole('button');
    expect(buttons.length).toBe(4);
  });

  test('renders HOME label', () => {
    const { getByText } = render(
      <TabBar state={mockState} descriptors={mockDescriptors} navigation={mockNavigation} />,
    );
    expect(getByText('HOME')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/mobile && pnpm test -- __tests__/components/TabBar.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Create TabBar.tsx**

```tsx
// src/components/shell/TabBar.tsx
import React from 'react';
import { View, Pressable, Text, StyleSheet } from 'react-native';
import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import { Mic, Newspaper, SquarePen, Library } from 'lucide-react-native';
import { useTheme } from '../../theme/theme';

const TAB_CONFIG = [
  { name: 'index', label: 'HOME', Icon: Mic, isHero: true },
  { name: 'briefs', label: 'BRIEFS', Icon: Newspaper, isHero: false },
  { name: 'board', label: 'BOARD', Icon: SquarePen, isHero: false },
  { name: 'library', label: 'LIBRARY', Icon: Library, isHero: false },
] as const;

interface TabBarProps {
  state: any;
  descriptors: any;
  navigation: any;
}

export function TabBar({ state, navigation }: TabBarProps) {
  const theme = useTheme();
  const { colors, fonts } = theme;

  return (
    <BlurView
      intensity={40}
      tint={theme.dark ? 'dark' : 'light'}
      style={[styles.container, { borderTopColor: colors.tabBarBorder }]}
    >
      <View style={[styles.inner, { backgroundColor: colors.tabBarBg }]}>
        {TAB_CONFIG.map((tab, idx) => {
          const isActive = state.index === idx;
          const routeName = state.routes[idx]?.name;

          const onPress = () => {
            const event = navigation.emit({ type: 'tabPress', target: state.routes[idx]?.key });
            if (!event.defaultPrevented) {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              navigation.navigate(routeName);
            }
          };

          if (tab.isHero) {
            return (
              <Pressable key={tab.name} onPress={onPress} style={styles.heroWrap} accessibilityRole="button">
                <View style={[
                  styles.heroCircle,
                  {
                    backgroundColor: isActive ? colors.accent : colors.iconBg,
                    shadowColor: isActive ? colors.accent : 'transparent',
                    shadowOpacity: isActive ? 0.4 : 0,
                    shadowRadius: 12,
                    shadowOffset: { width: 0, height: 4 },
                  },
                ]}>
                  <tab.Icon size={22} strokeWidth={1.8} color={isActive ? '#FFFFFF' : colors.ink} />
                </View>
                <Text style={[
                  styles.label,
                  { fontFamily: fonts.mono, color: isActive ? colors.accent : colors.secondary },
                ]}>{tab.label}</Text>
              </Pressable>
            );
          }

          return (
            <Pressable key={tab.name} onPress={onPress} style={styles.tab} accessibilityRole="button">
              <tab.Icon
                size={22}
                strokeWidth={isActive ? 1.8 : 1.4}
                color={isActive ? colors.ink : (theme.dark ? '#626260' : colors.secondary)}
              />
              <Text style={[
                styles.label,
                {
                  fontFamily: fonts.mono,
                  fontWeight: isActive ? '500' : '400',
                  color: isActive ? colors.ink : (theme.dark ? '#626260' : colors.secondary),
                },
              ]}>{tab.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </BlurView>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  inner: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingTop: 10,
    paddingBottom: 28,
    paddingHorizontal: 12,
  },
  tab: {
    alignItems: 'center',
    gap: 4,
    paddingVertical: 8,
    paddingHorizontal: 12,
    minWidth: 56,
  },
  heroWrap: {
    alignItems: 'center',
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  heroCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontSize: 10,
    letterSpacing: 0.4,
  },
});
```

- [ ] **Step 4: Create tab layout**

```tsx
// app/(tabs)/_layout.tsx
import { Tabs } from 'expo-router';
import { TabBar } from '../../src/components/shell/TabBar';

export default function TabsLayout() {
  return (
    <Tabs
      tabBar={(props) => <TabBar {...props} />}
      screenOptions={{ headerShown: false }}
    >
      <Tabs.Screen name="index" />
      <Tabs.Screen name="briefs" />
      <Tabs.Screen name="board" />
      <Tabs.Screen name="library" />
    </Tabs>
  );
}
```

- [ ] **Step 5: Create placeholder tab screens** (so the app can actually run)

```tsx
// app/(tabs)/index.tsx
import { View, Text } from 'react-native';
import { useTheme } from '../../src/theme/theme';

export default function HomeScreen() {
  const { colors } = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: colors.ink }}>Home — M1</Text>
    </View>
  );
}
```

```tsx
// app/(tabs)/briefs.tsx
import { View, Text } from 'react-native';
import { useTheme } from '../../src/theme/theme';

export default function BriefsScreen() {
  const { colors } = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: colors.ink }}>Briefs — M4</Text>
    </View>
  );
}
```

```tsx
// app/(tabs)/board.tsx
import { View, Text } from 'react-native';
import { useTheme } from '../../src/theme/theme';

export default function BoardScreen() {
  const { colors } = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: colors.ink }}>Board — M7</Text>
    </View>
  );
}
```

```tsx
// app/(tabs)/library.tsx
import { View, Text } from 'react-native';
import { useTheme } from '../../src/theme/theme';

export default function LibraryScreen() {
  const { colors } = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: colors.ink }}>Library — M8</Text>
    </View>
  );
}
```

- [ ] **Step 6: Run TabBar test**

Run: `cd packages/mobile && pnpm test -- __tests__/components/TabBar.test.tsx`
Expected: PASS.

- [ ] **Step 7: Verify app starts in Expo Go**

Run: `cd packages/mobile && npx expo start --clear`
Expected: App launches, TabBar renders with 4 tabs, elevated mic button visible on Home tab.

- [ ] **Step 8: Commit**

```bash
git add packages/mobile/src/components/shell/ packages/mobile/app/ packages/mobile/__tests__/components/
git commit -m "feat(mobile): custom TabBar with 4 tabs + tab layout + placeholder screens"
```

---

## Task 5: Primitive components — MCard, MPill, MEyebrow, TopBar, MButton, Hairline, IconBox, SectionHeader, ListRow

**Files:**
- Create: `packages/mobile/src/components/primitives/MCard.tsx`
- Create: `packages/mobile/src/components/primitives/MPill.tsx`
- Create: `packages/mobile/src/components/primitives/MEyebrow.tsx`
- Create: `packages/mobile/src/components/primitives/MButton.tsx`
- Create: `packages/mobile/src/components/primitives/Hairline.tsx`
- Create: `packages/mobile/src/components/primitives/IconBox.tsx`
- Create: `packages/mobile/src/components/primitives/SectionHeader.tsx`
- Create: `packages/mobile/src/components/primitives/ListRow.tsx`
- Create: `packages/mobile/src/components/shell/TopBar.tsx`
- Test: `packages/mobile/__tests__/components/MPill.test.tsx`

**Design source:** `_mobile-shell.jsx` lines 153-199 (MCard, MEyebrow, MMeta, MPill) with tone-aware palettes.

- [ ] **Step 1: Write MPill test**

```tsx
// __tests__/components/MPill.test.tsx
import React from 'react';
import { render } from '@testing-library/react-native';
import { MPill } from '../../src/components/primitives/MPill';

jest.mock('../../src/theme/theme', () => ({
  useTheme: () => ({
    dark: false,
    colors: {
      body: '#40403E',
      secondary: '#8F8E85',
      cardBg: '#FFFFFF',
      hairline: '#E4E2DC',
      iconBg: '#F0EEE6',
      accent: '#CC785C',
      accentDarker: '#8C3F28',
      accentLight: '#FBEFE9',
      accentLighter: '#F2D5C6',
      successText: '#4A6B3A',
      warnText: '#8B6F3A',
    },
    fonts: { body: 'Inter_400Regular' },
  }),
}));

describe('MPill', () => {
  test('renders children text', () => {
    const { getByText } = render(<MPill>Q4 Planning</MPill>);
    expect(getByText('Q4 Planning')).toBeTruthy();
  });

  test('renders with accent tone', () => {
    const { getByText } = render(<MPill tone="accent">Q4 Planning</MPill>);
    expect(getByText('Q4 Planning')).toBeTruthy();
  });

  test('renders with success tone', () => {
    const { getByText } = render(<MPill tone="success">Complete</MPill>);
    expect(getByText('Complete')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/mobile && pnpm test -- __tests__/components/MPill.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Create all primitive components**

```tsx
// src/components/primitives/MCard.tsx
import React from 'react';
import { View, ViewStyle, StyleSheet } from 'react-native';
import { useTheme } from '../../theme/theme';

interface MCardProps {
  children: React.ReactNode;
  style?: ViewStyle;
  padding?: number;
}

export function MCard({ children, style, padding = 16 }: MCardProps) {
  const { colors } = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: colors.cardBg, borderColor: colors.hairline, padding }, style]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1 },
});
```

```tsx
// src/components/primitives/MPill.tsx
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '../../theme/theme';

type PillTone = 'neutral' | 'accent' | 'success' | 'warn';

interface MPillProps {
  children: React.ReactNode;
  tone?: PillTone;
}

export function MPill({ children, tone = 'neutral' }: MPillProps) {
  const { colors, dark, fonts } = useTheme();

  const toneMap = {
    neutral: {
      bg: dark ? '#262624' : '#E8E6DB',
      fg: colors.body,
      bd: colors.hairline,
    },
    accent: {
      bg: dark ? '#3A1F14' : colors.accentLight,
      fg: colors.accentDarker,
      bd: dark ? '#5A2D1F' : colors.accentLighter,
    },
    success: {
      bg: dark ? '#1E2A1A' : '#E8EEE5',
      fg: colors.successText,
      bd: dark ? '#2A3D24' : '#C8D5BF',
    },
    warn: {
      bg: dark ? '#2E2416' : '#F5EFE2',
      fg: colors.warnText,
      bd: dark ? '#3E3120' : '#D9C89C',
    },
  };

  const t = toneMap[tone];

  return (
    <View style={[styles.pill, { backgroundColor: t.bg, borderColor: t.bd }]}>
      <Text style={[styles.text, { color: t.fg, fontFamily: fonts.body }]}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 2,
    paddingHorizontal: 8,
    borderWidth: 1,
  },
  text: { fontSize: 11, fontWeight: '500' },
});
```

```tsx
// src/components/primitives/MEyebrow.tsx
import React from 'react';
import { Text, TextStyle } from 'react-native';
import { useTheme } from '../../theme/theme';

interface MEyebrowProps {
  children: React.ReactNode;
  color?: string;
  style?: TextStyle;
}

export function MEyebrow({ children, color, style }: MEyebrowProps) {
  const { colors, text } = useTheme();
  return (
    <Text style={[text.eyebrow, { color: color ?? colors.accent, marginBottom: 6 }, style]}>
      {children}
    </Text>
  );
}
```

```tsx
// src/components/primitives/MButton.tsx
import React from 'react';
import { Pressable, Text, StyleSheet, ViewStyle } from 'react-native';
import { useTheme } from '../../theme/theme';

interface MButtonProps {
  children: React.ReactNode;
  onPress?: () => void;
  variant?: 'primary' | 'ghost';
  style?: ViewStyle;
  icon?: React.ReactNode;
}

export function MButton({ children, onPress, variant = 'primary', style, icon }: MButtonProps) {
  const { colors, fonts } = useTheme();

  const isPrimary = variant === 'primary';

  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.button,
        {
          backgroundColor: isPrimary ? colors.accent : 'transparent',
          borderWidth: isPrimary ? 0 : 1,
          borderColor: isPrimary ? undefined : colors.hairline,
        },
        style,
      ]}
    >
      {icon}
      <Text style={[
        styles.text,
        {
          fontFamily: fonts.body,
          color: isPrimary ? '#FFFFFF' : colors.ink,
          fontWeight: isPrimary ? '600' : '500',
        },
      ]}>{children}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    paddingHorizontal: 20,
  },
  text: { fontSize: 14 },
});
```

```tsx
// src/components/primitives/Hairline.tsx
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useTheme } from '../../theme/theme';

export function Hairline() {
  const { colors } = useTheme();
  return <View style={[styles.line, { backgroundColor: colors.hairline }]} />;
}

const styles = StyleSheet.create({
  line: { height: StyleSheet.hairlineWidth },
});
```

```tsx
// src/components/primitives/IconBox.tsx
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useTheme } from '../../theme/theme';

interface IconBoxProps {
  children: React.ReactNode;
  size?: number;
}

export function IconBox({ children, size = 34 }: IconBoxProps) {
  const { colors } = useTheme();
  return (
    <View style={[styles.box, { width: size, height: size, backgroundColor: colors.iconBg }]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: 'center', justifyContent: 'center' },
});
```

```tsx
// src/components/primitives/SectionHeader.tsx
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useTheme } from '../../theme/theme';

interface SectionHeaderProps {
  label: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function SectionHeader({ label, actionLabel, onAction }: SectionHeaderProps) {
  const { colors, text } = useTheme();
  return (
    <View style={styles.row}>
      <Text style={[text.eyebrow, { color: colors.secondary }]}>{label}</Text>
      {actionLabel && (
        <Pressable onPress={onAction}>
          <Text style={[text.meta, { color: colors.accent }]}>{actionLabel}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 },
});
```

```tsx
// src/components/primitives/ListRow.tsx
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useTheme } from '../../theme/theme';
import { IconBox } from './IconBox';

interface ListRowProps {
  icon?: React.ReactNode;
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  last?: boolean;
  onPress?: () => void;
}

export function ListRow({ icon, title, subtitle, right, last, onPress }: ListRowProps) {
  const { colors, fonts } = useTheme();

  const content = (
    <View style={[styles.row, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.hairline }]}>
      {icon && <IconBox>{icon}</IconBox>}
      <View style={styles.body}>
        <Text style={[styles.title, { color: colors.ink, fontFamily: fonts.bodyMedium }]} numberOfLines={1}>{title}</Text>
        {subtitle && <Text style={[styles.sub, { color: colors.secondary, fontFamily: fonts.mono }]}>{subtitle}</Text>}
      </View>
      {right}
    </View>
  );

  if (onPress) return <Pressable onPress={onPress}>{content}</Pressable>;
  return content;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 12, alignItems: 'center', paddingVertical: 14, paddingHorizontal: 16 },
  body: { flex: 1, minWidth: 0 },
  title: { fontSize: 14 },
  sub: { fontSize: 11, marginTop: 2 },
});
```

```tsx
// src/components/shell/TopBar.tsx
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../theme/theme';

interface TopBarProps {
  eyebrow?: string;
  title?: string;
  leftAction?: React.ReactNode;
  rightAction?: React.ReactNode;
}

export function TopBar({ eyebrow, title, leftAction, rightAction }: TopBarProps) {
  const { colors, text } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.container, {
      paddingTop: insets.top + 14,
      backgroundColor: colors.bg,
      borderBottomColor: colors.hairline,
    }]}>
      <View style={styles.inner}>
        <View style={styles.left}>
          {leftAction && !title && leftAction}
          {eyebrow && (
            <Text style={[text.eyebrow, { color: colors.accent, marginBottom: 4 }]}>{eyebrow}</Text>
          )}
          {title && (
            <Text style={[text.displayMedium, { color: colors.ink }]}>{title}</Text>
          )}
        </View>
        {rightAction && <View style={styles.right}>{rightAction}</View>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 20,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  inner: { flexDirection: 'row', alignItems: 'flex-end', gap: 12 },
  left: { flex: 1, minWidth: 0 },
  right: { paddingBottom: 4 },
});
```

- [ ] **Step 4: Run MPill test**

Run: `cd packages/mobile && pnpm test -- __tests__/components/MPill.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/mobile/src/components/primitives/ packages/mobile/src/components/shell/TopBar.tsx packages/mobile/__tests__/components/MPill.test.tsx
git commit -m "feat(mobile): primitive components — MCard, MPill, MEyebrow, MButton, Hairline, IconBox, SectionHeader, ListRow, TopBar"
```

---

## Task 6: Types + API client + config

**Files:**
- Create: `packages/mobile/src/lib/types.ts`
- Create: `packages/mobile/src/lib/config.ts`
- Create: `packages/mobile/src/lib/api-client.ts`
- Create: `packages/mobile/src/lib/storage.ts`
- Modify: `packages/core-api/src/middleware/rate-limit.ts:181` (add bypass entry)
- Test: `packages/mobile/__tests__/lib/api-client.test.ts`

**Pattern source:** `packages/web-next/lib/api-client.ts` (namespaced functions, HttpError, `X-Open-Brain-Caller` header) and `packages/web-next/lib/types.ts` (local type declarations).

- [ ] **Step 1: Write API client test**

```typescript
// __tests__/lib/api-client.test.ts
import { HttpError, buildQueryString } from '../../src/lib/api-client';

describe('HttpError', () => {
  test('captures status, body, and path', () => {
    const err = new HttpError(404, { error: 'Not found' }, '/captures/123');
    expect(err.status).toBe(404);
    expect(err.body).toEqual({ error: 'Not found' });
    expect(err.path).toBe('/captures/123');
    expect(err.message).toBe('HTTP 404 on /captures/123');
  });
});

describe('buildQueryString', () => {
  test('builds from params, skipping undefined', () => {
    const qs = buildQueryString({ limit: 20, offset: undefined, brain_view: 'career' });
    expect(qs).toBe('?limit=20&brain_view=career');
  });

  test('returns empty string for empty params', () => {
    expect(buildQueryString({})).toBe('');
  });

  test('handles arrays as repeated keys', () => {
    const qs = buildQueryString({ tags: ['a', 'b'] });
    expect(qs).toContain('tags=a');
    expect(qs).toContain('tags=b');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/mobile && pnpm test -- __tests__/lib/api-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create config.ts**

```typescript
// src/lib/config.ts
const DEFAULT_API_URL = 'https://brain.troy-davis.com/api/v1';
const DEFAULT_VOICE_URL = 'http://homeserver.k4jda.net:3001';

export const config = {
  get apiBaseUrl(): string {
    return process.env.EXPO_PUBLIC_API_URL ?? DEFAULT_API_URL;
  },
  get voiceCaptureUrl(): string {
    return process.env.EXPO_PUBLIC_VOICE_URL ?? DEFAULT_VOICE_URL;
  },
};
```

- [ ] **Step 4: Create types.ts**

This is a subset of `packages/web-next/lib/types.ts` — only the types the mobile screens need.

```typescript
// src/lib/types.ts
export type CaptureType = 'decision' | 'idea' | 'observation' | 'task' | 'win' | 'blocker' | 'question' | 'reflection';
export type CaptureSource = 'slack' | 'voice' | 'api' | 'document' | 'mcp' | 'email' | 'file' | 'consolidation' | 'system';
export type PipelineStatus = 'pending' | 'processing' | 'extracted' | 'embedded' | 'chunked' | 'complete' | 'failed' | 'deleted';
export type BrainView = 'career' | 'personal' | 'technical' | 'work-internal' | 'client';
export type EntityType = 'person' | 'project' | 'topic' | 'org' | 'decision' | 'concept' | 'place' | 'tool';
export type BriefKind = 'DAILY' | 'WEEKLY' | 'DOSSIER' | 'DECISION' | 'PROJECT' | 'MONTHLY';
export type CommitmentStatus = 'pending' | 'owed_by_user' | 'waiting_on' | 'resolved';

export interface Capture {
  id: string;
  content: string;
  created_at: string;
  capture_type: CaptureType;
  source: CaptureSource;
  pipeline_status: PipelineStatus;
  brain_view: BrainView;
  title?: string;
  snippet?: string;
  entities?: string[];
  source_metadata?: Record<string, unknown> | null;
}

export interface Entity {
  id: string;
  name: string;
  entity_type: EntityType;
  mention_count: number;
  blurb?: string;
  last_seen?: string;
}

export interface EntityDetail extends Entity {
  first_seen_at: string;
  last_seen_at: string | null;
  canonical_name: string;
  aliases: string[];
  metadata: unknown;
  created_at: string;
  updated_at: string;
  linked_captures: Array<{
    id: string;
    content: string;
    capture_type: string;
    brain_view: string;
    relationship: string | null;
    confidence: number | null;
    created_at: string;
  }>;
  summary?: string;
}

export interface Brief {
  id: string;
  kind: BriefKind;
  title: string;
  subtitle: string;
  generated_at: string;
  read_at: string | null;
  dismissed_at: string | null;
  created_at: string;
}

export interface BriefDetail extends Brief {
  body_html: string;
  toc: Array<{ id: string; label: string }>;
  sources: Array<{ type: string; title: string; date: string }>;
  refine_options: string[];
}

export interface SearchResult {
  capture: Capture;
  score: number;
}

export interface BoardCommitment {
  id: string;
  capture_id: string;
  entity_id: string | null;
  entity_name: string | null;
  text: string;
  due_date: string | null;
  status: CommitmentStatus;
  resolved_at: string | null;
  created_at: string;
}

export interface ListEnvelope<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface VoiceCaptureResponse {
  ok: boolean;
  capture: { id: string; pipeline_status: string; created_at: string };
  transcription: { text: string; language: string; duration: number };
  classification: { template: string; confidence: number };
}
```

- [ ] **Step 5: Create api-client.ts**

```typescript
// src/lib/api-client.ts
import { config } from './config';
import type {
  Capture, Entity, EntityDetail, Brief, BriefDetail,
  SearchResult, BoardCommitment, ListEnvelope, BrainView, CaptureType,
  CommitmentStatus,
} from './types';

export class HttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly path: string;

  constructor(status: number, body: unknown, path: string) {
    super(`HTTP ${status} on ${path}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.path = path;
  }
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = `${config.apiBaseUrl}${path}`;

  const headers: Record<string, string> = {
    'X-Open-Brain-Caller': 'mobile-app',
    ...(init.headers as Record<string, string> | undefined),
  };

  if (init.body !== undefined && init.body !== null && typeof init.body === 'string') {
    if (!headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
  }

  const response = await fetch(url, { ...init, headers });

  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = await response.text().catch(() => null);
    }
    throw new HttpError(response.status, body, path);
  }

  if (response.status === 204) return undefined as unknown as T;
  return response.json() as Promise<T>;
}

export function buildQueryString(params: Record<string, unknown>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null) qs.append(key, String(item));
      }
    } else {
      qs.set(key, String(value));
    }
  }
  const str = qs.toString();
  return str ? `?${str}` : '';
}

export const capturesApi = {
  list: (params: { limit?: number; offset?: number; brain_view?: BrainView; capture_type?: CaptureType } = {}): Promise<ListEnvelope<Capture>> => {
    return request<ListEnvelope<Capture>>(`/captures${buildQueryString(params)}`);
  },
  get: (id: string): Promise<Capture> => {
    return request<Capture>(`/captures/${encodeURIComponent(id)}`);
  },
  create: (payload: { content: string; capture_type: CaptureType; brain_view: BrainView; source?: string }): Promise<{ id: string; pipeline_status: string; created_at: string }> => {
    return request('/captures', { method: 'POST', body: JSON.stringify(payload) });
  },
};

export const entitiesApi = {
  list: (params: { limit?: number; offset?: number; type_filter?: string; sort_by?: string } = {}): Promise<ListEnvelope<Entity>> => {
    return request<ListEnvelope<Entity>>(`/entities${buildQueryString(params)}`);
  },
  get: (id: string): Promise<EntityDetail> => {
    return request<EntityDetail>(`/entities/${encodeURIComponent(id)}`);
  },
};

export const briefsApi = {
  list: (params: { limit?: number; offset?: number; kind?: string } = {}): Promise<ListEnvelope<Brief>> => {
    return request<ListEnvelope<Brief>>(`/briefs${buildQueryString(params)}`);
  },
  get: (id: string): Promise<{ brief: Record<string, unknown> }> => {
    return request<{ brief: Record<string, unknown> }>(`/briefs/${encodeURIComponent(id)}`);
  },
  patchRead: (id: string, read: boolean): Promise<void> => {
    return request<void>(`/briefs/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ read }) });
  },
};

export const searchApi = {
  search: (params: { q: string; limit?: number; include_related?: boolean }): Promise<{ results: SearchResult[]; total: number; query: string }> => {
    return request(`/search${buildQueryString(params)}`);
  },
};

export const commitmentsApi = {
  list: (params: { status?: CommitmentStatus; limit?: number; offset?: number } = {}): Promise<ListEnvelope<BoardCommitment>> => {
    return request<ListEnvelope<BoardCommitment>>(`/commitments${buildQueryString(params)}`);
  },
  patch: (id: string, body: { resolved?: boolean; status?: CommitmentStatus }): Promise<BoardCommitment> => {
    return request<BoardCommitment>(`/commitments/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) });
  },
};

export const settingsApi = {
  get: (key: string): Promise<{ key: string; value: unknown; updated_at: string | null }> => {
    return request(`/settings/${encodeURIComponent(key)}`);
  },
};

export const statsApi = {
  get: (): Promise<{ total_captures: number; by_type: Record<string, number>; by_view: Record<string, number> }> => {
    return request('/stats');
  },
};
```

- [ ] **Step 6: Create storage.ts**

```typescript
// src/lib/storage.ts
import * as SecureStore from 'expo-secure-store';

const KEYS = {
  API_TOKEN: 'ob_api_token',
  VOICE_URL: 'ob_voice_url',
} as const;

export const storage = {
  getApiToken: () => SecureStore.getItemAsync(KEYS.API_TOKEN),
  setApiToken: (token: string) => SecureStore.setItemAsync(KEYS.API_TOKEN, token),
  getVoiceUrl: () => SecureStore.getItemAsync(KEYS.VOICE_URL),
  setVoiceUrl: (url: string) => SecureStore.setItemAsync(KEYS.VOICE_URL, url),
};
```

- [ ] **Step 7: Add mobile-app to rate-limit bypass callers**

In `packages/core-api/src/middleware/rate-limit.ts`, add `'internal:mobile-app'` to the BYPASS_CALLERS Set after line 180 (`'internal:newsletter-pipeline'`):

```typescript
      // P21 — financial advisor newsletter assessment pipeline (open-brain-vm cron)
      'internal:newsletter-pipeline',
      // Mobile app — React Native Expo client
      'internal:mobile-app',
    ])
```

- [ ] **Step 8: Run API client test**

Run: `cd packages/mobile && pnpm test -- __tests__/lib/api-client.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 9: Commit**

```bash
git add packages/mobile/src/lib/ packages/mobile/__tests__/lib/ packages/core-api/src/middleware/rate-limit.ts
git commit -m "feat(mobile): types, API client, config, storage + add mobile-app rate-limit bypass"
```

---

## Task 7: TanStack Query hooks

**Files:**
- Create: `packages/mobile/src/hooks/useCaptures.ts`
- Create: `packages/mobile/src/hooks/useBriefs.ts`
- Create: `packages/mobile/src/hooks/useEntities.ts`
- Create: `packages/mobile/src/hooks/useSearch.ts`
- Create: `packages/mobile/src/hooks/useCommitments.ts`

- [ ] **Step 1: Create all hooks**

```typescript
// src/hooks/useCaptures.ts
import { useQuery } from '@tanstack/react-query';
import { capturesApi, type CapturesListParams } from '../lib/api-client';

type CapturesListParams = Parameters<typeof capturesApi.list>[0];

export function useCaptures(params: CapturesListParams = {}) {
  return useQuery({
    queryKey: ['captures', params],
    queryFn: () => capturesApi.list(params),
  });
}

export function useCapture(id: string | undefined) {
  return useQuery({
    queryKey: ['capture', id],
    queryFn: () => capturesApi.get(id!),
    enabled: !!id,
  });
}
```

```typescript
// src/hooks/useBriefs.ts
import { useQuery } from '@tanstack/react-query';
import { briefsApi } from '../lib/api-client';

export function useBriefs(params: { limit?: number; offset?: number; kind?: string } = {}) {
  return useQuery({
    queryKey: ['briefs', params],
    queryFn: () => briefsApi.list(params),
  });
}

export function useBrief(id: string | undefined) {
  return useQuery({
    queryKey: ['brief', id],
    queryFn: () => briefsApi.get(id!),
    enabled: !!id,
  });
}
```

```typescript
// src/hooks/useEntities.ts
import { useQuery } from '@tanstack/react-query';
import { entitiesApi } from '../lib/api-client';

export function useEntities(params: { limit?: number; offset?: number; type_filter?: string; sort_by?: string } = {}) {
  return useQuery({
    queryKey: ['entities', params],
    queryFn: () => entitiesApi.list(params),
  });
}

export function useEntity(id: string | undefined) {
  return useQuery({
    queryKey: ['entity', id],
    queryFn: () => entitiesApi.get(id!),
    enabled: !!id,
  });
}
```

```typescript
// src/hooks/useSearch.ts
import { useQuery } from '@tanstack/react-query';
import { searchApi } from '../lib/api-client';

export function useSearch(query: string, options: { limit?: number; enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['search', query, options.limit],
    queryFn: () => searchApi.search({ q: query, limit: options.limit }),
    enabled: (options.enabled ?? true) && query.length > 0,
  });
}
```

```typescript
// src/hooks/useCommitments.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { commitmentsApi } from '../lib/api-client';
import type { CommitmentStatus } from '../lib/types';

export function useCommitments(params: { status?: CommitmentStatus; limit?: number } = {}) {
  return useQuery({
    queryKey: ['commitments', params],
    queryFn: () => commitmentsApi.list(params),
  });
}

export function usePatchCommitment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: { resolved?: boolean; status?: CommitmentStatus } }) =>
      commitmentsApi.patch(id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['commitments'] });
    },
  });
}
```

- [ ] **Step 2: Verify type-check passes**

Run: `cd packages/mobile && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add packages/mobile/src/hooks/
git commit -m "feat(mobile): TanStack Query hooks for captures, briefs, entities, search, commitments"
```

---

## Task 8: Voice capture — audio recording + upload to voice-capture service

**Files:**
- Create: `packages/mobile/src/lib/audio.ts`
- Create: `packages/mobile/src/hooks/useRecording.ts`

**CRITICAL:** Upload goes to voice-capture:3001 `POST /api/capture`, NOT core-api. Multipart field name is `file` (not `audio`). Response is `VoiceCaptureResponse`. Batch only — no streaming transcript.

- [ ] **Step 1: Create audio.ts**

```typescript
// src/lib/audio.ts
import { Audio } from 'expo-av';
import { config } from './config';
import type { VoiceCaptureResponse } from './types';

const RECORDING_OPTIONS: Audio.RecordingOptions = {
  isMeteringEnabled: true,
  android: {
    extension: '.m4a',
    outputFormat: Audio.AndroidOutputFormat.MPEG_4,
    audioEncoder: Audio.AndroidAudioEncoder.AAC,
    sampleRate: 44100,
    numberOfChannels: 1,
    bitRate: 128000,
  },
  ios: {
    extension: '.m4a',
    outputFormat: Audio.IOSOutputFormat.MPEG4AAC,
    audioQuality: Audio.IOSAudioQuality.HIGH,
    sampleRate: 44100,
    numberOfChannels: 1,
    bitRate: 128000,
  },
  web: { mimeType: 'audio/webm', bitsPerSecond: 128000 },
};

export async function requestMicPermission(): Promise<boolean> {
  const { status } = await Audio.requestPermissionsAsync();
  return status === 'granted';
}

export async function startRecording(): Promise<Audio.Recording> {
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: true,
    playsInSilentModeIOS: true,
  });
  const { recording } = await Audio.Recording.createAsync(RECORDING_OPTIONS);
  return recording;
}

export async function stopRecording(recording: Audio.Recording): Promise<string> {
  await recording.stopAndUnloadAsync();
  await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
  const uri = recording.getURI();
  if (!uri) throw new Error('Recording URI is null');
  return uri;
}

export async function uploadAudio(
  uri: string,
  brainView: string = 'personal',
): Promise<VoiceCaptureResponse> {
  const formData = new FormData();

  // React Native FormData accepts { uri, name, type } objects
  formData.append('file', {
    uri,
    name: 'recording.m4a',
    type: 'audio/mp4',
  } as unknown as Blob);

  formData.append('brain_view', brainView);
  formData.append('device', 'mobile_app');

  const response = await fetch(`${config.voiceCaptureUrl}/api/capture`, {
    method: 'POST',
    body: formData,
    // Do NOT set Content-Type — fetch sets it with multipart boundary
  });

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`Voice upload failed (${response.status}): ${text}`);
  }

  return response.json() as Promise<VoiceCaptureResponse>;
}
```

- [ ] **Step 2: Create useRecording hook**

```typescript
// src/hooks/useRecording.ts
import { useState, useRef, useCallback, useEffect } from 'react';
import { Audio } from 'expo-av';
import {
  requestMicPermission,
  startRecording,
  stopRecording,
  uploadAudio,
} from '../lib/audio';
import type { VoiceCaptureResponse } from '../lib/types';

type RecordingState = 'idle' | 'recording' | 'uploading' | 'done' | 'error';

interface UseRecordingReturn {
  state: RecordingState;
  elapsed: number;
  metering: number;
  result: VoiceCaptureResponse | null;
  error: string | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  reset: () => void;
}

export function useRecording(): UseRecordingReturn {
  const [state, setState] = useState<RecordingState>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [metering, setMetering] = useState(-160);
  const [result, setResult] = useState<VoiceCaptureResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const start = useCallback(async () => {
    const granted = await requestMicPermission();
    if (!granted) {
      setError('Microphone permission denied');
      setState('error');
      return;
    }

    setElapsed(0);
    setResult(null);
    setError(null);

    const recording = await startRecording();
    recordingRef.current = recording;
    setState('recording');

    recording.setOnRecordingStatusUpdate((status) => {
      if (status.isRecording && status.metering !== undefined) {
        setMetering(status.metering);
      }
    });

    const startTime = Date.now();
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 200);
  }, []);

  const stop = useCallback(async () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    if (!recordingRef.current) return;

    setState('uploading');

    try {
      const uri = await stopRecording(recordingRef.current);
      recordingRef.current = null;

      const captureResult = await uploadAudio(uri);
      setResult(captureResult);
      setState('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
      setState('error');
    }
  }, []);

  const reset = useCallback(() => {
    setState('idle');
    setElapsed(0);
    setMetering(-160);
    setResult(null);
    setError(null);
  }, []);

  return { state, elapsed, metering, result, error, start, stop, reset };
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/mobile/src/lib/audio.ts packages/mobile/src/hooks/useRecording.ts
git commit -m "feat(mobile): voice capture — expo-av recording + upload to voice-capture:3001"
```

---

## Task 9: M1 Home screen

**Files:**
- Modify: `packages/mobile/app/(tabs)/index.tsx` (replace placeholder)
- Create: `packages/mobile/src/components/capture/HeroRecordButton.tsx`
- Create: `packages/mobile/src/components/capture/QuickCaptureGrid.tsx`

**Design source:** `m1-home.jsx` — hero record button with concentric rings, quick capture grid, today's brief card, recent captures list.

- [ ] **Step 1: Create HeroRecordButton**

```tsx
// src/components/capture/HeroRecordButton.tsx
import React from 'react';
import { View, Pressable, Text, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Mic } from 'lucide-react-native';
import { useTheme } from '../../theme/theme';

interface HeroRecordButtonProps {
  onPress: () => void;
}

export function HeroRecordButton({ onPress }: HeroRecordButtonProps) {
  const { colors, text, dark } = useTheme();

  const ringColor1 = dark ? 'rgba(204,120,92,0.14)' : 'rgba(204,120,92,0.16)';
  const ringColor2 = dark ? 'rgba(204,120,92,0.22)' : 'rgba(204,120,92,0.24)';

  return (
    <View style={styles.container}>
      <Text style={[text.eyebrow, { color: colors.accent, marginBottom: 18 }]}>
        Tap to capture · hold to speak
      </Text>

      <Pressable onPress={onPress} style={styles.buttonWrap}>
        <View style={[styles.outerRing, { borderColor: ringColor1 }]} />
        <View style={[styles.innerRing, { borderColor: ringColor2 }]} />
        <LinearGradient
          colors={['#D88967', '#CC785C', '#B25A3D']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.core}
        >
          <Mic size={44} strokeWidth={1.4} color="#FFFFFF" />
        </LinearGradient>
      </Pressable>

      <Text style={[text.title, { color: colors.ink, marginTop: 4 }]}>Record a thought</Text>
      <Text style={[text.metaSmall, { color: colors.secondary, marginTop: 4 }]}>
        AUTO-TRANSCRIBED · LINKED TO ENTITIES
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'center', paddingVertical: 28, paddingHorizontal: 24 },
  buttonWrap: { width: 180, height: 180, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  outerRing: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 90,
    borderWidth: 1,
  },
  innerRing: {
    position: 'absolute',
    top: 18, left: 18, right: 18, bottom: 18,
    borderRadius: 72,
    borderWidth: 1,
  },
  core: {
    position: 'absolute',
    top: 36, left: 36, right: 36, bottom: 36,
    borderRadius: 54,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#CC785C',
    shadowOpacity: 0.35,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
});
```

- [ ] **Step 2: Create QuickCaptureGrid**

```tsx
// src/components/capture/QuickCaptureGrid.tsx
import React from 'react';
import { View, Pressable, Text, StyleSheet } from 'react-native';
import { Type, Camera, Link } from 'lucide-react-native';
import { useTheme } from '../../theme/theme';

const ITEMS = [
  { Icon: Type, label: 'Note' },
  { Icon: Camera, label: 'Photo' },
  { Icon: Link, label: 'Link' },
] as const;

export function QuickCaptureGrid() {
  const { colors, text } = useTheme();

  return (
    <View style={styles.grid}>
      {ITEMS.map((item) => (
        <Pressable
          key={item.label}
          style={[styles.cell, { backgroundColor: colors.cardBg, borderColor: colors.hairline }]}
        >
          <item.Icon size={18} strokeWidth={1.5} color={colors.ink} />
          <Text style={[text.eyebrow, { color: colors.secondary, fontSize: 10, marginBottom: 0 }]}>
            {item.label.toUpperCase()}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', gap: 8 },
  cell: {
    flex: 1,
    alignItems: 'center',
    gap: 6,
    paddingVertical: 14,
    borderWidth: 1,
  },
});
```

- [ ] **Step 3: Replace Home screen placeholder**

```tsx
// app/(tabs)/index.tsx
import React from 'react';
import { ScrollView, View, Text, Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { Bell, Mic, Mail, FileUp } from 'lucide-react-native';
import { useTheme } from '../../src/theme/theme';
import { TopBar } from '../../src/components/shell/TopBar';
import { MCard } from '../../src/components/primitives/MCard';
import { MPill } from '../../src/components/primitives/MPill';
import { SectionHeader } from '../../src/components/primitives/SectionHeader';
import { IconBox } from '../../src/components/primitives/IconBox';
import { HeroRecordButton } from '../../src/components/capture/HeroRecordButton';
import { QuickCaptureGrid } from '../../src/components/capture/QuickCaptureGrid';
import { useCaptures } from '../../src/hooks/useCaptures';
import { useBriefs } from '../../src/hooks/useBriefs';

export default function HomeScreen() {
  const { colors, text, tabBarHeight } = useTheme();
  const router = useRouter();
  const { data: capturesData } = useCaptures({ limit: 3 });
  const { data: briefsData } = useBriefs({ limit: 1 });

  const now = new Date();
  const dayLabel = now.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
  const dateLabel = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
  const timeLabel = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

  const latestBrief = briefsData?.items?.[0];

  const sourceIcon = (source: string) => {
    switch (source) {
      case 'voice': return Mic;
      case 'email': return Mail;
      default: return FileUp;
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <TopBar
        eyebrow={`${dayLabel} · ${dateLabel} · ${timeLabel}`}
        title={`Good ${now.getHours() < 12 ? 'morning' : now.getHours() < 18 ? 'afternoon' : 'evening'}, Troy.`}
        rightAction={
          <Pressable style={[styles.iconBtn, { backgroundColor: colors.iconBg }]}>
            <Bell size={16} strokeWidth={1.6} color={colors.ink} />
          </Pressable>
        }
      />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 20, paddingBottom: tabBarHeight + 20 }}
      >
        <Text style={[text.body, { color: colors.secondary, marginBottom: 28, marginTop: -4 }]}>
          {capturesData?.total
            ? `${capturesData.total} total captures`
            : 'Loading captures...'}
        </Text>

        <MCard style={{ marginBottom: 24 }}>
          <HeroRecordButton onPress={() => router.push('/record')} />
        </MCard>

        <View style={{ marginBottom: 28 }}>
          <QuickCaptureGrid />
        </View>

        {latestBrief && (
          <View style={{ marginBottom: 24 }}>
            <SectionHeader label="Today's brief" actionLabel="OPEN →" onAction={() => router.push(`/briefs/${latestBrief.id}`)} />
            <MCard>
              <Text style={[text.title, { color: colors.ink, marginBottom: 10 }]}>{latestBrief.title}</Text>
              <Text style={[text.bodySmall, { color: colors.body, marginBottom: 14 }]}>{latestBrief.subtitle}</Text>
              <View style={[styles.tagRow, { borderTopColor: colors.hairline }]}>
                <MPill tone="accent">Brief</MPill>
              </View>
            </MCard>
          </View>
        )}

        <View style={{ marginBottom: 20 }}>
          <SectionHeader label="Recent" actionLabel="ALL →" onAction={() => router.push('/(tabs)/library')} />
          <MCard padding={0}>
            {capturesData?.items.map((capture, i) => {
              const Icon = sourceIcon(capture.source);
              return (
                <View key={capture.id} style={[
                  styles.captureRow,
                  i < (capturesData.items.length - 1) && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.hairline },
                ]}>
                  <IconBox><Icon size={15} strokeWidth={1.5} color={colors.body} /></IconBox>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[styles.captureTitle, { color: colors.ink }]} numberOfLines={1}>
                      {capture.title ?? capture.content.slice(0, 60)}
                    </Text>
                    <Text style={[text.meta, { color: colors.secondary }]}>
                      {capture.entities?.slice(0, 2).join(' · ') ?? capture.source}
                    </Text>
                  </View>
                  <Text style={[text.meta, { color: colors.secondary }]}>
                    {new Date(capture.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </Text>
                </View>
              );
            })}
          </MCard>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  iconBtn: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  tagRow: { flexDirection: 'row', gap: 6, flexWrap: 'wrap', paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  captureRow: { flexDirection: 'row', gap: 12, paddingVertical: 14, paddingHorizontal: 16 },
  captureTitle: { fontSize: 14, fontWeight: '500', marginBottom: 2 },
});
```

- [ ] **Step 4: Verify app runs with Home screen data**

Run: `cd packages/mobile && npx expo start --clear`
Expected: Home screen renders with hero record button, quick capture grid, and data loading from API (or graceful loading state if API unreachable).

- [ ] **Step 5: Commit**

```bash
git add packages/mobile/src/components/capture/ packages/mobile/app/\(tabs\)/index.tsx
git commit -m "feat(mobile): M1 Home screen — hero record, quick capture, brief card, recent captures"
```

---

## Task 10: M2 Recording screen + M3 Confirm screen (voice critical path)

**Files:**
- Create: `packages/mobile/app/record.tsx`
- Create: `packages/mobile/app/confirm.tsx`
- Create: `packages/mobile/src/components/capture/Waveform.tsx`
- Create: `packages/mobile/src/components/capture/RecordControls.tsx`

**Design source:** `m2-record.jsx` (full-screen, no tab/top bar, waveform, timer, controls) and `m3-confirm.jsx` (transcript, entities, save/discard). **CRITICAL:** No live transcript. Recording shows waveform + timer. After stop, shows "Transcribing..." while uploading. On success, navigates to confirm screen with transcript + entities from voice-capture response.

- [ ] **Step 1: Create Waveform component**

```tsx
// src/components/capture/Waveform.tsx
import React, { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTheme } from '../../theme/theme';

interface WaveformProps {
  metering: number;
  barCount?: number;
}

export function Waveform({ metering, barCount = 48 }: WaveformProps) {
  const { colors, dark } = useTheme();
  const normalizedLevel = Math.max(0, Math.min(1, (metering + 160) / 160));

  const bars = useMemo(() => {
    return Array.from({ length: barCount }, (_, i) => {
      const t = i / barCount;
      const base = 8 + Math.abs(Math.sin(t * 18) * Math.cos(t * 7) * 52);
      const isActive = i > barCount - 10;
      const height = Math.max(4, isActive ? base * normalizedLevel * 1.5 : base * 0.4);
      return { height, isActive };
    });
  }, [barCount, normalizedLevel]);

  return (
    <View style={styles.container}>
      {bars.map((bar, i) => (
        <View
          key={i}
          style={[
            styles.bar,
            {
              height: bar.height,
              backgroundColor: bar.isActive ? colors.accent : (dark ? '#3A3A36' : colors.secondary),
              opacity: bar.isActive ? 1 : 0.5,
            },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3, height: 120, paddingHorizontal: 24 },
  bar: { width: 3, borderRadius: 2 },
});
```

- [ ] **Step 2: Create RecordControls**

```tsx
// src/components/capture/RecordControls.tsx
import React from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { RotateCcw, Check } from 'lucide-react-native';
import { useTheme } from '../../theme/theme';

interface RecordControlsProps {
  onRestart: () => void;
  onStop: () => void;
  onConfirm: () => void;
}

export function RecordControls({ onRestart, onStop, onConfirm }: RecordControlsProps) {
  const { colors, dark } = useTheme();
  const borderColor = dark ? 'rgba(240,238,230,0.12)' : colors.secondary;

  return (
    <View style={[styles.container, { borderTopColor: colors.hairline, backgroundColor: dark ? '#141413' : '#FFFFFF' }]}>
      <Pressable style={[styles.sideBtn, { borderColor }]} onPress={onRestart}>
        <RotateCcw size={18} strokeWidth={1.6} color={colors.ink} />
      </Pressable>

      <Pressable style={styles.stopBtn} onPress={onStop}>
        <View style={[styles.stopOuter, { borderColor: dark ? '#0E0E0D' : '#F0EEE6' }]}>
          <View style={styles.stopSquare} />
        </View>
      </Pressable>

      <Pressable style={[styles.sideBtn, { borderColor }]} onPress={onConfirm}>
        <Check size={18} strokeWidth={1.8} color={colors.ink} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: 44,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  sideBtn: {
    width: 48, height: 48, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  stopBtn: { width: 68, height: 68 },
  stopOuter: {
    width: 68, height: 68, borderRadius: 34,
    backgroundColor: '#CC785C',
    borderWidth: 4,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#CC785C', shadowOpacity: 0.4, shadowRadius: 18, shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  stopSquare: { width: 22, height: 22, backgroundColor: '#FFFFFF' },
});
```

- [ ] **Step 3: Create M2 Recording screen**

```tsx
// app/record.tsx
import React from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { X } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../src/theme/theme';
import { Waveform } from '../src/components/capture/Waveform';
import { RecordControls } from '../src/components/capture/RecordControls';
import { useRecording } from '../src/hooks/useRecording';

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export default function RecordScreen() {
  const { colors, text, dark } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { state, elapsed, metering, result, error, start, stop, reset } = useRecording();

  React.useEffect(() => {
    start();
  }, [start]);

  React.useEffect(() => {
    if (state === 'done' && result) {
      router.replace({
        pathname: '/confirm',
        params: {
          transcript: result.transcription.text,
          captureType: result.classification.template,
          confidence: String(result.classification.confidence),
          captureId: result.capture.id,
          duration: String(result.transcription.duration),
        },
      });
    }
  }, [state, result, router]);

  const bg = dark ? '#0E0E0D' : colors.bg;

  return (
    <View style={[styles.screen, { backgroundColor: bg }]}>
      <View style={[styles.topMeta, { paddingTop: insets.top + 16 }]}>
        <View>
          <Text style={[text.eyebrow, { color: colors.accent, marginBottom: 4 }]}>
            {state === 'recording' ? '● RECORDING' : state === 'uploading' ? '◉ TRANSCRIBING' : '○ READY'}
          </Text>
          <Text style={[text.meta, { color: colors.secondary }]}>
            {new Date().toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase()} · {new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}
          </Text>
        </View>
        <Pressable style={{ padding: 8 }} onPress={() => { reset(); router.back(); }}>
          <X size={22} strokeWidth={1.6} color={colors.ink} />
        </Pressable>
      </View>

      <Text style={[text.timer, { color: colors.ink, textAlign: 'center', paddingTop: 40, paddingBottom: 8 }]}>
        {formatTime(elapsed)}
      </Text>
      <Text style={[text.metaSmall, { color: colors.secondary, textAlign: 'center', marginBottom: 32 }]}>
        {state === 'uploading' ? 'TRANSCRIBING · PLEASE WAIT' : 'ELAPSED · TAP TO PAUSE'}
      </Text>

      {state === 'uploading' ? (
        <View style={styles.spinner}>
          <ActivityIndicator size="large" color={colors.accent} />
          <Text style={[text.meta, { color: colors.secondary, marginTop: 16 }]}>Sending to Whisper...</Text>
        </View>
      ) : (
        <Waveform metering={metering} />
      )}

      <View style={{ flex: 1 }} />

      {error && (
        <View style={styles.errorBox}>
          <Text style={[text.body, { color: '#BF4939' }]}>{error}</Text>
        </View>
      )}

      {state === 'recording' && (
        <RecordControls
          onRestart={() => { reset(); start(); }}
          onStop={stop}
          onConfirm={stop}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  topMeta: { paddingHorizontal: 24, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  spinner: { alignItems: 'center', justifyContent: 'center', height: 120, paddingHorizontal: 24 },
  errorBox: { paddingHorizontal: 24, paddingVertical: 12 },
});
```

- [ ] **Step 4: Create M3 Confirm screen**

```tsx
// app/confirm.tsx
import React from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { ChevronLeft, Check } from 'lucide-react-native';
import { Pressable } from 'react-native';
import { useTheme } from '../src/theme/theme';
import { TopBar } from '../src/components/shell/TopBar';
import { MCard } from '../src/components/primitives/MCard';
import { MEyebrow } from '../src/components/primitives/MEyebrow';
import { MButton } from '../src/components/primitives/MButton';

export default function ConfirmScreen() {
  const { colors, text } = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{
    transcript: string;
    captureType: string;
    confidence: string;
    captureId: string;
    duration: string;
  }>();

  const durationLabel = params.duration
    ? `${Math.floor(Number(params.duration) / 60)}:${String(Math.round(Number(params.duration) % 60)).padStart(2, '0')}`
    : '0:00';

  const handleDiscard = () => {
    router.back();
  };

  const handleSave = () => {
    router.dismissAll();
    router.replace('/(tabs)');
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <TopBar
        eyebrow={`VOICE · ${durationLabel} · AUTO-TRANSCRIBED`}
        title="Review capture"
        leftAction={
          <Pressable onPress={() => router.back()} style={{ padding: 0 }}>
            <ChevronLeft size={22} strokeWidth={1.8} color={colors.ink} />
          </Pressable>
        }
      />

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20, paddingBottom: 120 }}>
        <MCard style={{ marginBottom: 18 }}>
          <MEyebrow>Transcript</MEyebrow>
          <Text style={[text.body, { color: colors.body, lineHeight: 23 }]}>
            {params.transcript}
          </Text>
        </MCard>

        <View style={{ marginBottom: 18 }}>
          <MEyebrow color={colors.secondary}>Classification</MEyebrow>
          <MCard>
            <View style={styles.classRow}>
              <Text style={[text.label, { color: colors.ink }]}>{params.captureType}</Text>
              <Text style={[text.meta, { color: Number(params.confidence) > 0.9 ? colors.successText : colors.secondary }]}>
                {Math.round(Number(params.confidence) * 100)}%
              </Text>
            </View>
          </MCard>
        </View>

        <View style={[styles.actions, { marginTop: 24 }]}>
          <MButton variant="ghost" onPress={handleDiscard} style={{ flex: 1 }}>
            Discard
          </MButton>
          <MButton
            onPress={handleSave}
            icon={<Check size={15} strokeWidth={2.2} color="#FFFFFF" />}
            style={{ flex: 2 }}
          >
            Save capture
          </MButton>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  classRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  actions: { flexDirection: 'row', gap: 8 },
});
```

- [ ] **Step 5: Test voice flow end-to-end on device**

Run: `cd packages/mobile && npx expo start --clear`
Expected: Tap hero mic → M2 recording with waveform + timer → press stop → "Transcribing..." spinner → navigates to M3 confirm with transcript + classification → Save returns to Home.

**NOTE:** Requires physical device (simulator mic input is limited). Also requires voice-capture service reachable via configured URL.

- [ ] **Step 6: Commit**

```bash
git add packages/mobile/app/record.tsx packages/mobile/app/confirm.tsx packages/mobile/src/components/capture/
git commit -m "feat(mobile): M2 recording + M3 confirm — voice critical path with batch transcript"
```

---

## Task 11: M4 Briefs list + M5 Brief reader

**Files:**
- Modify: `packages/mobile/app/(tabs)/briefs.tsx` (replace placeholder)
- Create: `packages/mobile/app/briefs/[id].tsx`
- Create: `packages/mobile/src/components/briefs/BriefListItem.tsx`
- Create: `packages/mobile/src/components/briefs/DropCap.tsx`

**Design source:** `m4-briefs.jsx` (grouped list with progress bars, accent left rail) and `m5-reader.jsx` (editorial reader with drop cap, pull quotes, sticky nav).

- [ ] **Step 1: Create BriefListItem**

```tsx
// src/components/briefs/BriefListItem.tsx
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useTheme } from '../../theme/theme';

interface BriefListItemProps {
  kind: string;
  title: string;
  meta: string;
  isAccent?: boolean;
  progress?: number;
  last?: boolean;
  onPress?: () => void;
}

export function BriefListItem({ kind, title, meta, isAccent, progress, last, onPress }: BriefListItemProps) {
  const { colors, text } = useTheme();

  return (
    <Pressable onPress={onPress} style={[
      styles.item,
      !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.hairline },
    ]}>
      {isAccent && <View style={[styles.accentRail, { backgroundColor: colors.accent }]} />}
      <Text style={[text.eyebrow, { color: isAccent ? colors.accent : colors.secondary, marginBottom: 6 }]}>
        {kind}
      </Text>
      <Text style={[text.title, { color: colors.ink, fontSize: 16, marginBottom: 6 }]}>{title}</Text>
      <Text style={[text.meta, { color: colors.secondary }]}>{meta}</Text>
      {progress !== undefined && (
        <View style={[styles.progressTrack, { backgroundColor: colors.iconBg, marginTop: 10 }]}>
          <View style={[styles.progressFill, { width: `${progress}%`, backgroundColor: colors.accent }]} />
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  item: { padding: 16, position: 'relative' },
  accentRail: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 2 },
  progressTrack: { height: 2 },
  progressFill: { height: '100%' },
});
```

- [ ] **Step 2: Create DropCap**

```tsx
// src/components/briefs/DropCap.tsx
import React from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { useTheme } from '../../theme/theme';

interface DropCapProps {
  letter: string;
  children: React.ReactNode;
}

export function DropCap({ letter, children }: DropCapProps) {
  const { colors, fonts } = useTheme();
  return (
    <View style={styles.wrap}>
      <Text style={[styles.letter, { color: colors.accent, fontFamily: fonts.display }]}>{letter}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  letter: { fontSize: 56, lineHeight: 50, marginRight: 8, marginTop: 6 },
});
```

- [ ] **Step 3: Replace Briefs screen placeholder**

```tsx
// app/(tabs)/briefs.tsx
import React from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { Plus } from 'lucide-react-native';
import { useTheme } from '../../src/theme/theme';
import { TopBar } from '../../src/components/shell/TopBar';
import { MCard } from '../../src/components/primitives/MCard';
import { MEyebrow } from '../../src/components/primitives/MEyebrow';
import { BriefListItem } from '../../src/components/briefs/BriefListItem';
import { useBriefs } from '../../src/hooks/useBriefs';

export default function BriefsScreen() {
  const { colors, tabBarHeight } = useTheme();
  const router = useRouter();
  const { data } = useBriefs({ limit: 20 });

  const items = data?.items ?? [];

  const todayBriefs = items.filter(b => {
    const d = new Date(b.generated_at);
    const now = new Date();
    return d.toDateString() === now.toDateString();
  });
  const weekBriefs = items.filter(b => {
    const d = new Date(b.generated_at);
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    return d > weekAgo && d.toDateString() !== now.toDateString();
  });
  const earlierBriefs = items.filter(b => {
    const d = new Date(b.generated_at);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    return d <= weekAgo;
  });

  const sections = [
    { label: 'Today', items: todayBriefs },
    { label: 'This week', items: weekBriefs },
    { label: 'Earlier', items: earlierBriefs },
  ].filter(s => s.items.length > 0);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <TopBar
        eyebrow={`${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase()} · ${items.filter(b => !b.read_at).length} UNREAD`}
        title="Briefs"
        rightAction={
          <Pressable style={{ padding: 8, paddingHorizontal: 12, backgroundColor: colors.accent, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Plus size={13} strokeWidth={2.2} color="#FFF" />
          </Pressable>
        }
      />
      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: tabBarHeight + 20 }}>
        {sections.map(section => (
          <View key={section.label} style={{ marginBottom: 24 }}>
            <MEyebrow color={colors.secondary}>{section.label}</MEyebrow>
            <MCard padding={0}>
              {section.items.map((brief, i) => (
                <BriefListItem
                  key={brief.id}
                  kind={brief.kind}
                  title={brief.title}
                  meta={brief.subtitle || new Date(brief.generated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  isAccent={section.label === 'Today' && i === 0}
                  last={i === section.items.length - 1}
                  onPress={() => router.push(`/briefs/${brief.id}`)}
                />
              ))}
            </MCard>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
```

- [ ] **Step 4: Create Brief reader screen**

```tsx
// app/briefs/[id].tsx
import React from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet, useWindowDimensions } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronLeft, Bookmark } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../src/theme/theme';
import { MEyebrow } from '../../src/components/primitives/MEyebrow';
import { Hairline } from '../../src/components/primitives/Hairline';
import { DropCap } from '../../src/components/briefs/DropCap';
import { useBrief } from '../../src/hooks/useBriefs';

export default function BriefReaderScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors, text, dark } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { data } = useBrief(id);

  const brief = data?.brief;
  const title = typeof brief?.title === 'string' ? brief.title : '';
  const bodyHtml = typeof brief?.body_html === 'string' ? brief.body_html : '';
  const kind = typeof brief?.kind === 'string' ? brief.kind : 'BRIEF';
  const generatedAt = typeof brief?.generated_at === 'string' ? brief.generated_at : (brief?.created_at as string ?? '');

  const dt = generatedAt ? new Date(generatedAt) : new Date();
  const eyebrow = `${kind} · ${dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase()}`;

  const bg = dark ? '#141413' : '#FAFAF7';

  return (
    <View style={{ flex: 1, backgroundColor: bg }}>
      <View style={[styles.stickyNav, { paddingTop: insets.top + 12, backgroundColor: bg, borderBottomColor: colors.hairline }]}>
        <Pressable onPress={() => router.back()} style={{ padding: 6 }}>
          <ChevronLeft size={22} strokeWidth={1.8} color={colors.ink} />
        </Pressable>
        <Text style={[text.eyebrow, { color: colors.secondary }]}>{eyebrow}</Text>
        <Pressable style={{ padding: 6 }}>
          <Bookmark size={20} strokeWidth={1.6} color={colors.ink} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ padding: 24, paddingBottom: 120 }}>
        <MEyebrow>{eyebrow}</MEyebrow>
        <Text style={[text.displayLarge, { color: colors.ink, marginBottom: 16 }]}>{title}</Text>
        <Hairline />

        <View style={{ marginTop: 28 }}>
          <Text style={[text.bodyReader, { color: dark ? '#D6D4CA' : colors.body }]}>
            {bodyHtml ? bodyHtml.replace(/<[^>]*>/g, '') : 'Loading brief content...'}
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  stickyNav: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
```

- [ ] **Step 5: Commit**

```bash
git add packages/mobile/app/\(tabs\)/briefs.tsx packages/mobile/app/briefs/ packages/mobile/src/components/briefs/
git commit -m "feat(mobile): M4 Briefs list + M5 Brief reader — grouped list, editorial reader"
```

---

## Task 12: M6 Entity dossier

**Files:**
- Create: `packages/mobile/app/entities/[id].tsx`
- Create: `packages/mobile/src/components/entity/EntityHero.tsx`
- Create: `packages/mobile/src/components/entity/StatsGrid.tsx`

**Design source:** `m6-entity.jsx` — avatar with initials, stats grid (3 cols), AI synthesis card, tabbed timeline.

- [ ] **Step 1: Create EntityHero and StatsGrid, then the screen**

```tsx
// src/components/entity/EntityHero.tsx
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '../../theme/theme';

interface EntityHeroProps {
  name: string;
  entityType: string;
  subType?: string;
  subtitle?: string;
  captureCount: number;
}

export function EntityHero({ name, entityType, subType, subtitle, captureCount }: EntityHeroProps) {
  const { colors, text } = useTheme();
  const initials = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();

  return (
    <View style={[styles.row, { borderBottomColor: colors.hairline }]}>
      <View style={[styles.avatar, { backgroundColor: colors.accentLight }]}>
        <Text style={[{ fontFamily: text.displayMedium.fontFamily, fontSize: 24, color: colors.accentDarker }]}>{initials}</Text>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[text.eyebrow, { color: colors.secondary, marginBottom: 4 }]}>
          {entityType.toUpperCase()}{subType ? ` · ${subType.toUpperCase()}` : ''}
        </Text>
        <Text style={[text.displaySmall, { color: colors.ink }]}>{name}</Text>
        {subtitle && <Text style={[text.meta, { color: colors.secondary, marginTop: 2 }]}>{subtitle} · {captureCount} captures</Text>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 14, alignItems: 'center', marginBottom: 20, paddingBottom: 20, borderBottomWidth: 1 },
  avatar: { width: 64, height: 64, alignItems: 'center', justifyContent: 'center' },
});
```

```tsx
// src/components/entity/StatsGrid.tsx
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '../../theme/theme';

interface StatItem { value: string; label: string }

export function StatsGrid({ items }: { items: StatItem[] }) {
  const { colors, text } = useTheme();
  return (
    <View style={styles.grid}>
      {items.map(item => (
        <View key={item.label} style={[styles.cell, { backgroundColor: colors.cardBg, borderColor: colors.hairline }]}>
          <Text style={[text.displaySmall, { color: colors.ink }]}>{item.value}</Text>
          <Text style={[text.eyebrow, { color: colors.secondary, marginTop: 2, marginBottom: 0, fontSize: 10 }]}>{item.label}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', gap: 8, marginBottom: 22 },
  cell: { flex: 1, borderWidth: 1, padding: 12, alignItems: 'center' },
});
```

```tsx
// app/entities/[id].tsx
import React from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronLeft, MoreHorizontal } from 'lucide-react-native';
import { useTheme } from '../../src/theme/theme';
import { TopBar } from '../../src/components/shell/TopBar';
import { MCard } from '../../src/components/primitives/MCard';
import { MEyebrow } from '../../src/components/primitives/MEyebrow';
import { EntityHero } from '../../src/components/entity/EntityHero';
import { StatsGrid } from '../../src/components/entity/StatsGrid';
import { useEntity } from '../../src/hooks/useEntities';

export default function EntityDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors, text } = useTheme();
  const router = useRouter();
  const { data: entity } = useEntity(id);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <TopBar
        leftAction={
          <Pressable onPress={() => router.back()}>
            <ChevronLeft size={22} strokeWidth={1.8} color={colors.ink} />
          </Pressable>
        }
        rightAction={
          <Pressable style={{ padding: 6 }}>
            <MoreHorizontal size={20} strokeWidth={1.6} color={colors.ink} />
          </Pressable>
        }
      />
      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 120 }}>
        {entity && (
          <>
            <EntityHero
              name={entity.name}
              entityType={entity.entity_type}
              captureCount={entity.mention_count}
              subtitle={entity.blurb}
            />

            <StatsGrid items={[
              { value: String(entity.mention_count), label: 'Captures' },
              { value: String(entity.linked_captures?.length ?? 0), label: 'Links' },
              { value: String(entity.aliases?.length ?? 0), label: 'Aliases' },
            ]} />

            {entity.summary && (
              <MCard style={{ marginBottom: 22 }}>
                <MEyebrow>Synthesis</MEyebrow>
                <Text style={[text.body, { color: colors.body, lineHeight: 23 }]}>{entity.summary}</Text>
              </MCard>
            )}

            <MEyebrow color={colors.secondary}>Recent captures</MEyebrow>
            {entity.linked_captures?.slice(0, 10).map((cap, i) => (
              <View key={cap.id} style={[styles.captureRow, { borderBottomColor: colors.hairline }]}>
                <View style={styles.dot}>
                  <View style={[styles.dotInner, { backgroundColor: colors.accent }]} />
                  {i < Math.min((entity.linked_captures?.length ?? 0) - 1, 9) && (
                    <View style={[styles.line, { backgroundColor: colors.hairline }]} />
                  )}
                </View>
                <View style={{ flex: 1, paddingBottom: 6 }}>
                  <Text style={[text.metaSmall, { color: colors.secondary, marginBottom: 3 }]}>
                    {new Date(cap.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </Text>
                  <Text style={[text.label, { color: colors.ink, marginBottom: 2 }]} numberOfLines={1}>
                    {cap.content.slice(0, 80)}
                  </Text>
                  <Text style={[text.meta, { color: colors.secondary }]}>{cap.capture_type}</Text>
                </View>
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  captureRow: { flexDirection: 'row', gap: 14, paddingBottom: 18 },
  dot: { width: 10, paddingTop: 4, alignItems: 'center' },
  dotInner: { width: 8, height: 8, borderRadius: 4 },
  line: { width: 1, flex: 1, marginTop: 4 },
});
```

- [ ] **Step 2: Commit**

```bash
git add packages/mobile/app/entities/ packages/mobile/src/components/entity/
git commit -m "feat(mobile): M6 Entity dossier — hero, stats grid, synthesis, capture timeline"
```

---

## Task 13: M7 Board + M8 Timeline (Library)

**Files:**
- Modify: `packages/mobile/app/(tabs)/board.tsx` (replace placeholder)
- Modify: `packages/mobile/app/(tabs)/library.tsx` (replace placeholder)
- Create: `packages/mobile/src/components/board/ColumnTabs.tsx`
- Create: `packages/mobile/src/components/board/DecisionCard.tsx`

**Design source:** `m7-board.jsx` (column tabs, decision cards with priority rails) and `m8-timeline.jsx` (date sections, capture rows with tag pills).

- [ ] **Step 1: Create Board components and screen**

```tsx
// src/components/board/ColumnTabs.tsx
import React from 'react';
import { View, Pressable, Text, StyleSheet } from 'react-native';
import { useTheme } from '../../theme/theme';

interface Column { name: string; count: number }

interface ColumnTabsProps {
  columns: Column[];
  activeIndex: number;
  onSelect: (index: number) => void;
}

export function ColumnTabs({ columns, activeIndex, onSelect }: ColumnTabsProps) {
  const { colors, text } = useTheme();
  return (
    <View style={[styles.row, { borderBottomColor: colors.hairline }]}>
      {columns.map((col, i) => (
        <Pressable key={col.name} onPress={() => onSelect(i)} style={[
          styles.tab,
          i === activeIndex && { borderBottomWidth: 2, borderBottomColor: colors.accent },
        ]}>
          <Text style={[text.eyebrow, {
            color: i === activeIndex ? colors.ink : colors.secondary,
            fontWeight: i === activeIndex ? '500' : '400',
            marginBottom: 0,
          }]}>
            {col.name} <Text style={{ color: colors.secondary }}>{col.count}</Text>
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 0, borderBottomWidth: 1, marginBottom: 20 },
  tab: { paddingVertical: 10, paddingRight: 14, marginRight: 20, marginBottom: -1 },
});
```

```tsx
// src/components/board/DecisionCard.tsx
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Check, ArrowRight } from 'lucide-react-native';
import { useTheme } from '../../theme/theme';

interface DecisionCardProps {
  title: string;
  meta: string;
  priority: 'high' | 'med' | 'done';
  onResolve?: () => void;
  onAdvance?: () => void;
}

export function DecisionCard({ title, meta, priority, onResolve, onAdvance }: DecisionCardProps) {
  const { colors, text, dark } = useTheme();
  const railColor = priority === 'high' ? colors.accent : (dark ? '#3A3A36' : colors.secondary);

  return (
    <View style={[styles.card, { backgroundColor: colors.cardBg, borderColor: colors.hairline }]}>
      <View style={[styles.rail, { backgroundColor: railColor }]} />
      <View style={{ marginLeft: 6, flex: 1 }}>
        <Text style={[text.eyebrow, { color: priority === 'high' ? colors.accent : colors.secondary, marginBottom: 6 }]}>
          {priority === 'high' ? 'HIGH PRIORITY' : priority === 'med' ? 'MEDIUM' : 'DECIDED'}
        </Text>
        <Text style={[text.title, { color: colors.ink, fontSize: 16, marginBottom: 10 }]}>{title}</Text>
        <View style={[styles.footer, { borderTopColor: colors.hairline }]}>
          <Text style={[text.meta, { color: colors.secondary, flex: 1 }]}>{meta}</Text>
          <View style={styles.actions}>
            {onResolve && (
              <Pressable style={{ padding: 4 }} onPress={onResolve}>
                <Check size={14} strokeWidth={1.8} color={colors.secondary} />
              </Pressable>
            )}
            {onAdvance && (
              <Pressable style={{ padding: 4 }} onPress={onAdvance}>
                <ArrowRight size={14} strokeWidth={1.8} color={colors.secondary} />
              </Pressable>
            )}
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, padding: 16, marginBottom: 10, position: 'relative', flexDirection: 'row' },
  rail: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3 },
  footer: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
  actions: { flexDirection: 'row', gap: 4 },
});
```

- [ ] **Step 2: Replace Board screen**

```tsx
// app/(tabs)/board.tsx
import React, { useState } from 'react';
import { View, ScrollView, Pressable, Text, StyleSheet } from 'react-native';
import { Filter, Plus } from 'lucide-react-native';
import { useTheme } from '../../src/theme/theme';
import { TopBar } from '../../src/components/shell/TopBar';
import { MCard } from '../../src/components/primitives/MCard';
import { MEyebrow } from '../../src/components/primitives/MEyebrow';
import { ColumnTabs } from '../../src/components/board/ColumnTabs';
import { DecisionCard } from '../../src/components/board/DecisionCard';
import { useCommitments, usePatchCommitment } from '../../src/hooks/useCommitments';

export default function BoardScreen() {
  const { colors, text, tabBarHeight } = useTheme();
  const [activeCol, setActiveCol] = useState(0);
  const { data: pendingData } = useCommitments({ status: 'pending', limit: 20 });
  const { data: waitingData } = useCommitments({ status: 'waiting_on', limit: 20 });
  const { data: resolvedData } = useCommitments({ status: 'resolved', limit: 10 });
  const patchMutation = usePatchCommitment();

  const columns = [
    { name: 'Open', count: pendingData?.total ?? 0 },
    { name: 'Pondering', count: waitingData?.total ?? 0 },
    { name: 'Decided', count: resolvedData?.total ?? 0 },
  ];

  const activeItems = activeCol === 0
    ? (pendingData?.items ?? [])
    : activeCol === 1
    ? (waitingData?.items ?? [])
    : (resolvedData?.items ?? []);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <TopBar
        eyebrow={`${(pendingData?.total ?? 0) + (waitingData?.total ?? 0) + (resolvedData?.total ?? 0)} TOTAL`}
        title="Board"
        rightAction={
          <Pressable style={{ padding: 6 }}>
            <Filter size={18} strokeWidth={1.6} color={colors.ink} />
          </Pressable>
        }
      />
      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: tabBarHeight + 20 }}>
        <ColumnTabs columns={columns} activeIndex={activeCol} onSelect={setActiveCol} />

        {activeItems.map(item => (
          <DecisionCard
            key={item.id}
            title={item.text}
            meta={`${item.entity_name ?? 'No entity'} · ${item.due_date ?? 'flexible'}`}
            priority={activeCol === 2 ? 'done' : (item.due_date && new Date(item.due_date) < new Date() ? 'high' : 'med')}
            onResolve={activeCol !== 2 ? () => patchMutation.mutate({ id: item.id, body: { status: 'resolved' } }) : undefined}
            onAdvance={activeCol === 0 ? () => patchMutation.mutate({ id: item.id, body: { status: 'waiting_on' } }) : undefined}
          />
        ))}

        {activeCol === 0 && (
          <Pressable style={[styles.addBtn, { borderColor: colors.hairline }]}>
            <Plus size={14} strokeWidth={1.6} color={colors.secondary} />
            <Text style={[text.bodySmall, { color: colors.secondary }]}>Add question</Text>
          </Pressable>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  addBtn: { padding: 14, borderWidth: 1, borderStyle: 'dashed', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 4 },
});
```

- [ ] **Step 3: Replace Library/Timeline screen**

```tsx
// app/(tabs)/library.tsx
import React from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native';
import { SlidersHorizontal, Mic, Mail, FileUp, Edit3, Calendar } from 'lucide-react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../../src/theme/theme';
import { TopBar } from '../../src/components/shell/TopBar';
import { MCard } from '../../src/components/primitives/MCard';
import { MPill } from '../../src/components/primitives/MPill';
import { MEyebrow } from '../../src/components/primitives/MEyebrow';
import { IconBox } from '../../src/components/primitives/IconBox';
import { useCaptures } from '../../src/hooks/useCaptures';

const SOURCE_ICONS: Record<string, typeof Mic> = { voice: Mic, email: Mail, file: FileUp, api: Edit3, document: FileUp, slack: Calendar };

export default function LibraryScreen() {
  const { colors, text, tabBarHeight } = useTheme();
  const router = useRouter();
  const { data } = useCaptures({ limit: 30 });

  const items = data?.items ?? [];

  const grouped = items.reduce<Record<string, typeof items>>((acc, cap) => {
    const dateKey = new Date(cap.created_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase();
    (acc[dateKey] ??= []).push(cap);
    return acc;
  }, {});

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <TopBar
        eyebrow={`${data?.total ?? 0} TOTAL`}
        title="Timeline"
        rightAction={
          <Pressable style={{ padding: 6 }}>
            <SlidersHorizontal size={18} strokeWidth={1.6} color={colors.ink} />
          </Pressable>
        }
      />
      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: tabBarHeight + 20 }}>
        {Object.entries(grouped).map(([dateKey, captures]) => (
          <View key={dateKey} style={{ marginBottom: 20 }}>
            <MEyebrow color={colors.secondary} style={{ letterSpacing: 1.4 }}>{dateKey}</MEyebrow>
            <MCard padding={0}>
              {captures.map((cap, i) => {
                const Icon = SOURCE_ICONS[cap.source] ?? FileUp;
                return (
                  <View key={cap.id} style={[
                    styles.captureRow,
                    i < captures.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.hairline },
                  ]}>
                    <IconBox size={30}><Icon size={14} strokeWidth={1.5} color={colors.body} /></IconBox>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <View style={styles.titleRow}>
                        <Text style={[text.label, { color: colors.ink, flex: 1 }]} numberOfLines={1}>
                          {cap.title ?? cap.content.slice(0, 60)}
                        </Text>
                        <Text style={[text.meta, { color: colors.secondary }]}>
                          {new Date(cap.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}
                        </Text>
                      </View>
                      <Text style={[text.bodySmall, { color: colors.body, marginBottom: 8 }]} numberOfLines={2}>
                        {cap.snippet ?? cap.content.slice(0, 120)}
                      </Text>
                      <View style={{ flexDirection: 'row', gap: 4, flexWrap: 'wrap' }}>
                        {cap.entities?.slice(0, 3).map(e => <MPill key={e}>{e}</MPill>)}
                      </View>
                    </View>
                  </View>
                );
              })}
            </MCard>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  captureRow: { padding: 14, paddingHorizontal: 16 },
  titleRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, marginBottom: 3 },
});
```

- [ ] **Step 4: Commit**

```bash
git add packages/mobile/app/\(tabs\)/board.tsx packages/mobile/app/\(tabs\)/library.tsx packages/mobile/src/components/board/
git commit -m "feat(mobile): M7 Board + M8 Timeline — column tabs, decision cards, capture feed"
```

---

## Task 14: M9 Search + M10 Settings + M11 Onboarding

**Files:**
- Create: `packages/mobile/app/search.tsx`
- Create: `packages/mobile/app/settings.tsx`
- Create: `packages/mobile/app/onboarding.tsx`
- Create: `packages/mobile/src/components/search/SearchBar.tsx`
- Create: `packages/mobile/src/components/search/ScopeChips.tsx`
- Create: `packages/mobile/src/components/settings/SettingsSection.tsx`
- Create: `packages/mobile/src/components/settings/SettingsRow.tsx`
- Create: `packages/mobile/src/components/settings/Toggle.tsx`

**Design source:** `m9-search.jsx`, `m10-settings.jsx`, `m11-empty.jsx`.

- [ ] **Step 1: Create Search components**

```tsx
// src/components/search/SearchBar.tsx
import React from 'react';
import { View, TextInput, Text, Pressable, StyleSheet } from 'react-native';
import { Search as SearchIcon } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../theme/theme';

interface SearchBarProps {
  value: string;
  onChangeText: (text: string) => void;
  hitCount?: number;
  onCancel: () => void;
}

export function SearchBar({ value, onChangeText, hitCount, onCancel }: SearchBarProps) {
  const { colors, text } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.container, { paddingTop: insets.top + 12, borderBottomColor: colors.hairline }]}>
      <View style={[styles.inputWrap, { backgroundColor: colors.iconBg, borderColor: colors.hairline }]}>
        <SearchIcon size={16} strokeWidth={1.6} color={colors.secondary} />
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder="Search captures, entities..."
          placeholderTextColor={colors.secondary}
          style={[styles.input, { color: colors.ink }]}
          autoFocus
          returnKeyType="search"
        />
        {hitCount !== undefined && (
          <Text style={[text.eyebrow, { color: colors.secondary, marginBottom: 0 }]}>{hitCount} HITS</Text>
        )}
      </View>
      <Pressable onPress={onCancel}>
        <Text style={[{ color: colors.accent, fontSize: 14, fontWeight: '500' }]}>Cancel</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 16, paddingBottom: 14, flexDirection: 'row', gap: 10, alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  inputWrap: { flex: 1, height: 40, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, borderWidth: 1 },
  input: { flex: 1, fontSize: 15 },
});
```

```tsx
// src/components/search/ScopeChips.tsx
import React from 'react';
import { View, Pressable, Text, StyleSheet } from 'react-native';
import { useTheme } from '../../theme/theme';

interface ScopeChipsProps {
  scopes: Array<{ label: string; count: number }>;
  activeIndex: number;
  onSelect: (index: number) => void;
}

export function ScopeChips({ scopes, activeIndex, onSelect }: ScopeChipsProps) {
  const { colors, text } = useTheme();
  return (
    <View style={styles.row}>
      {scopes.map((scope, i) => (
        <Pressable
          key={scope.label}
          onPress={() => onSelect(i)}
          style={[styles.chip, {
            backgroundColor: i === activeIndex ? colors.accent : colors.iconBg,
            borderColor: i === activeIndex ? colors.accent : colors.hairline,
          }]}
        >
          <Text style={[text.meta, {
            color: i === activeIndex ? '#FFFFFF' : colors.body,
          }]}>{scope.label.toUpperCase()} · {scope.count}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginBottom: 20 },
  chip: { paddingVertical: 6, paddingHorizontal: 11, borderWidth: 1 },
});
```

- [ ] **Step 2: Create Search screen**

```tsx
// app/search.tsx
import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../src/theme/theme';
import { MCard } from '../src/components/primitives/MCard';
import { MEyebrow } from '../src/components/primitives/MEyebrow';
import { SearchBar } from '../src/components/search/SearchBar';
import { ScopeChips } from '../src/components/search/ScopeChips';
import { useSearch } from '../src/hooks/useSearch';

export default function SearchScreen() {
  const { colors, text } = useTheme();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const { data } = useSearch(query, { limit: 20 });

  const results = data?.results ?? [];

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <SearchBar
        value={query}
        onChangeText={setQuery}
        hitCount={data?.total}
        onCancel={() => router.back()}
      />
      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 120 }}>
        <ScopeChips
          scopes={[
            { label: 'All', count: data?.total ?? 0 },
            { label: 'Captures', count: results.length },
          ]}
          activeIndex={0}
          onSelect={() => {}}
        />

        <MEyebrow color={colors.secondary}>Results</MEyebrow>
        <MCard padding={0}>
          {results.map((r, i) => (
            <View key={r.capture.id} style={[
              styles.result,
              i < results.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.hairline },
            ]}>
              <View style={styles.resultHeader}>
                <Text style={[text.eyebrow, { color: colors.secondary, marginBottom: 0 }]}>{r.capture.source.toUpperCase()}</Text>
                <Text style={[text.meta, { color: colors.secondary }]}>
                  {new Date(r.capture.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </Text>
              </View>
              <Text style={[text.label, { color: colors.ink, marginBottom: 3 }]} numberOfLines={1}>
                {r.capture.title ?? r.capture.content.slice(0, 60)}
              </Text>
              <Text style={[text.bodySmall, { color: colors.body }]} numberOfLines={2}>
                {r.capture.content.slice(0, 150)}
              </Text>
            </View>
          ))}
        </MCard>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  result: { padding: 12, paddingHorizontal: 16 },
  resultHeader: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, marginBottom: 4 },
});
```

- [ ] **Step 3: Create Settings components and screen**

```tsx
// src/components/settings/SettingsSection.tsx
import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../../theme/theme';
import { MEyebrow } from '../primitives/MEyebrow';
import { MCard } from '../primitives/MCard';

export function SettingsSection({ label, children }: { label: string; children: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={{ marginBottom: 22 }}>
      <MEyebrow color={colors.secondary} style={{ paddingHorizontal: 4 }}>{label}</MEyebrow>
      <MCard padding={0}>{children}</MCard>
    </View>
  );
}
```

```tsx
// src/components/settings/SettingsRow.tsx
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '../../theme/theme';
import { IconBox } from '../primitives/IconBox';

interface SettingsRowProps {
  icon?: React.ReactNode;
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  last?: boolean;
}

export function SettingsRow({ icon, title, subtitle, right, last }: SettingsRowProps) {
  const { colors, text } = useTheme();
  return (
    <View style={[styles.row, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.hairline }]}>
      {icon && <IconBox size={30}>{icon}</IconBox>}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[text.label, { color: colors.ink, fontSize: 14.5 }]}>{title}</Text>
        {subtitle && <Text style={[text.meta, { color: colors.secondary, marginTop: 2 }]}>{subtitle}</Text>}
      </View>
      {right}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 14, alignItems: 'center', paddingVertical: 14, paddingHorizontal: 16 },
});
```

```tsx
// src/components/settings/Toggle.tsx
import React from 'react';
import { Pressable, View, StyleSheet } from 'react-native';
import { useTheme } from '../../theme/theme';

interface ToggleProps {
  value: boolean;
  onValueChange?: (value: boolean) => void;
}

export function Toggle({ value, onValueChange }: ToggleProps) {
  const { colors, dark } = useTheme();
  return (
    <Pressable onPress={() => onValueChange?.(!value)} style={[styles.track, {
      backgroundColor: value ? colors.accent : (dark ? '#3A3A36' : colors.secondary),
    }]}>
      <View style={[styles.thumb, { left: value ? 20 : 2 }]} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  track: { width: 44, height: 26, borderRadius: 13, justifyContent: 'center' },
  thumb: { position: 'absolute', top: 2, width: 22, height: 22, borderRadius: 11, backgroundColor: '#FFF', shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 3 },
});
```

```tsx
// app/settings.tsx
import React from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { Mic, Brain, Sparkles, Mail, Calendar, Sun, Type, Lock, Download, ChevronRight } from 'lucide-react-native';
import { useTheme } from '../src/theme/theme';
import { TopBar } from '../src/components/shell/TopBar';
import { MCard } from '../src/components/primitives/MCard';
import { SettingsSection } from '../src/components/settings/SettingsSection';
import { SettingsRow } from '../src/components/settings/SettingsRow';
import { Toggle } from '../src/components/settings/Toggle';

export default function SettingsScreen() {
  const { colors, text } = useTheme();
  const Chev = () => <ChevronRight size={16} strokeWidth={1.6} color={colors.secondary} />;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <TopBar eyebrow="ACCOUNT · TROY @ OPEN BRAIN" title="Settings" />
      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 120 }}>
        <MCard style={[styles.profileCard, { marginBottom: 22 }]}>
          <View style={[styles.avatar, { backgroundColor: colors.accent }]}>
            <Text style={{ color: '#FFF', fontFamily: text.displayMedium.fontFamily, fontSize: 20 }}>T</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[text.title, { color: colors.ink, fontSize: 17 }]}>Troy Davis</Text>
            <Text style={[text.meta, { color: colors.secondary, marginTop: 2 }]}>troy@openbrain.co</Text>
          </View>
          <Chev />
        </MCard>

        <SettingsSection label="Capture">
          <SettingsRow icon={<Mic size={14} strokeWidth={1.5} color={colors.body} />} title="Voice transcription" subtitle="Whisper large-v3 · server" right={<Toggle value={true} />} />
          <SettingsRow icon={<Brain size={14} strokeWidth={1.5} color={colors.body} />} title="Auto-extract entities" right={<Toggle value={true} />} />
          <SettingsRow icon={<Sparkles size={14} strokeWidth={1.5} color={colors.body} />} title="Daily brief" subtitle="Generate at 7:00 AM" right={<Toggle value={true} />} last />
        </SettingsSection>

        <SettingsSection label="Sources">
          <SettingsRow icon={<Mail size={14} strokeWidth={1.5} color={colors.body} />} title="Email" subtitle="brain@troy-davis.com" right={<Chev />} />
          <SettingsRow icon={<Calendar size={14} strokeWidth={1.5} color={colors.body} />} title="Slack" subtitle="Connected" right={<Chev />} last />
        </SettingsSection>

        <SettingsSection label="Appearance">
          <SettingsRow icon={<Sun size={14} strokeWidth={1.5} color={colors.body} />} title="Theme" subtitle="System" right={<Chev />} />
          <SettingsRow icon={<Type size={14} strokeWidth={1.5} color={colors.body} />} title="Reading size" subtitle="Medium" right={<Chev />} last />
        </SettingsSection>

        <SettingsSection label="Privacy">
          <SettingsRow icon={<Lock size={14} strokeWidth={1.5} color={colors.body} />} title="Self-hosted" subtitle="Data on your homeserver" right={<Chev />} />
          <SettingsRow icon={<Download size={14} strokeWidth={1.5} color={colors.body} />} title="Export all data" subtitle="JSON" right={<Chev />} last />
        </SettingsSection>

        <Text style={[text.metaSmall, { color: colors.secondary, textAlign: 'center', marginTop: 16 }]}>
          OPEN BRAIN · v0.1.0
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  profileCard: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  avatar: { width: 52, height: 52, alignItems: 'center', justifyContent: 'center' },
});
```

- [ ] **Step 4: Create Onboarding/Empty state screen**

```tsx
// app/onboarding.tsx
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { Mic } from 'lucide-react-native';
import { useTheme } from '../src/theme/theme';
import { MCard } from '../src/components/primitives/MCard';
import { MEyebrow } from '../src/components/primitives/MEyebrow';

const STEPS = [
  { n: '01', t: 'Capture', d: 'Voice · text · photo · link' },
  { n: '02', t: 'Link', d: 'Entities & past captures, automatic' },
  { n: '03', t: 'Brief', d: 'Daily synthesis at 7:00 AM' },
];

export default function OnboardingScreen() {
  const { colors, text } = useTheme();
  const router = useRouter();

  return (
    <View style={[styles.screen, { backgroundColor: colors.bg }]}>
      <View style={styles.content}>
        <MEyebrow style={{ textAlign: 'center', marginBottom: 18 }}>A fresh slate · no captures yet</MEyebrow>

        <Text style={[text.displayLarge, { color: colors.ink, textAlign: 'center', marginBottom: 16 }]}>
          Start with a thought.{'\n'}Open Brain does the rest.
        </Text>

        <Text style={[text.body, { color: colors.body, textAlign: 'center', maxWidth: 320, marginBottom: 36, lineHeight: 23 }]}>
          Speak, type, or drop anything in. We'll transcribe, extract the people and projects inside, and thread it to what you've said before.
        </Text>

        <View style={styles.stepsWrap}>
          {STEPS.map(step => (
            <MCard key={step.n} style={styles.step}>
              <View style={styles.stepInner}>
                <Text style={[text.eyebrow, { color: colors.accent, minWidth: 22, marginBottom: 0 }]}>{step.n}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={[text.label, { color: colors.ink, fontWeight: '500', fontSize: 15 }]}>{step.t}</Text>
                  <Text style={[text.meta, { color: colors.secondary }]}>{step.d}</Text>
                </View>
              </View>
            </MCard>
          ))}
        </View>

        <Pressable
          onPress={() => router.push('/record')}
          style={[styles.cta, { backgroundColor: colors.accent }]}
        >
          <Mic size={17} strokeWidth={1.8} color="#FFFFFF" />
          <Text style={styles.ctaText}>Record your first thought</Text>
        </Pressable>

        <Text style={[text.metaSmall, { color: colors.secondary, marginTop: 14 }]}>
          OR TYPE · IMPORT · CONNECT A SOURCE
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, paddingTop: 80 },
  stepsWrap: { gap: 10, width: '100%', maxWidth: 320, marginBottom: 36 },
  step: { padding: 12 },
  stepInner: { flexDirection: 'row', gap: 14, alignItems: 'center' },
  cta: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 16, paddingHorizontal: 36,
    shadowColor: '#CC785C', shadowOpacity: 0.32, shadowRadius: 18, shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  ctaText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
});
```

- [ ] **Step 5: Commit**

```bash
git add packages/mobile/app/search.tsx packages/mobile/app/settings.tsx packages/mobile/app/onboarding.tsx packages/mobile/src/components/search/ packages/mobile/src/components/settings/
git commit -m "feat(mobile): M9 Search + M10 Settings + M11 Onboarding — all remaining screens"
```

---

## Task 15: Final verification + type-check

**Files:** None created — validation only.

- [ ] **Step 1: Run type-check**

Run: `cd packages/mobile && npx tsc --noEmit`
Expected: No errors. If there are errors, fix them.

- [ ] **Step 2: Run all tests**

Run: `cd packages/mobile && pnpm test`
Expected: All tests pass.

- [ ] **Step 3: Verify core-api rate-limit change doesn't break existing tests**

Run: `pnpm --filter @open-brain/core-api exec vitest run`
Expected: All existing tests pass.

- [ ] **Step 4: Launch app and navigate all screens**

Run: `cd packages/mobile && npx expo start --clear`
Expected: Verify each route renders:
- `/(tabs)` — Home with hero button, quick capture, brief card, recent captures
- `/(tabs)/briefs` — Grouped brief list
- `/(tabs)/board` — Column tabs, decision cards
- `/(tabs)/library` — Timeline with date sections
- `/record` — Recording with waveform + timer
- `/confirm` — Transcript + classification review
- `/briefs/[id]` — Editorial reader
- `/entities/[id]` — Entity dossier
- `/search` — Search bar + results
- `/settings` — Profile + settings groups
- `/onboarding` — Empty state CTA

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat(mobile): verify all 11 screens render, type-check clean, tests pass"
```

---

## Self-Review Checklist

| Check | Status |
|-------|--------|
| **All 11 screens have tasks** | M1 (Task 9), M2 (Task 10), M3 (Task 10), M4 (Task 11), M5 (Task 11), M6 (Task 12), M7 (Task 13), M8 (Task 13), M9 (Task 14), M10 (Task 14), M11 (Task 14) |
| **No @open-brain/shared import** | Types in `src/lib/types.ts`, never imported from shared |
| **Voice uploads to voice-capture:3001** | `audio.ts` → `config.voiceCaptureUrl/api/capture`, field `file` |
| **Batch transcript, not streaming** | M2 shows waveform during recording, spinner during upload, navigates to M3 with result |
| **Rate-limit bypass added** | `internal:mobile-app` in `rate-limit.ts:181` |
| **X-Open-Brain-Caller header** | `mobile-app` in `api-client.ts` request wrapper |
| **No placeholder steps** | Every step has complete code |
| **Type consistency** | `VoiceCaptureResponse`, `ListEnvelope<T>`, all enums consistent across types.ts and api-client.ts |
| **Font family names match @expo-google-fonts** | `SpaceGrotesk_400Regular`, `Inter_400Regular`, `JetBrainsMono_400Regular` etc. |
| **Tab names match Expo Router file names** | `index`, `briefs`, `board`, `library` |
