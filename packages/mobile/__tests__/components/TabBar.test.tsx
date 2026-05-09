import React from 'react';
import { render } from '@testing-library/react-native';

// Mock react-native with enough fidelity for component rendering.
// jest.mock factories cannot reference outer-scope variables, so we use
// require() inside each factory for React references.
// Additional host components (TextInput, Image, Switch, ScrollView, Modal) are
// required by @testing-library/react-native's host-component-name detection.
jest.mock('react-native', () => {
  const R = require('react');
  return {
    View: 'View',
    Text: 'Text',
    TextInput: 'TextInput',
    Image: 'Image',
    Switch: 'Switch',
    ScrollView: 'ScrollView',
    Modal: 'Modal',
    Pressable: ({ children, accessibilityRole, ...rest }: any) =>
      R.createElement('Pressable', { accessibilityRole, ...rest }, children),
    StyleSheet: {
      create: (styles: any) => styles,
      flatten: (style: any) => (Array.isArray(style) ? Object.assign({}, ...style) : style ?? {}),
      hairlineWidth: 0.5,
    },
    Platform: { OS: 'ios', select: (obj: any) => obj.ios },
    useColorScheme: jest.fn(() => 'light'),
  };
});

jest.mock('expo-blur', () => ({
  BlurView: 'BlurView',
}));

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(),
  ImpactFeedbackStyle: { Light: 'light' },
}));

jest.mock('lucide-react-native', () => ({
  Mic: 'Mic',
  Newspaper: 'Newspaper',
  SquarePen: 'SquarePen',
  Library: 'Library',
}));

// Must import after mocks are set up
const { TabBar } = require('../../src/components/shell/TabBar');

const mockNavigation = {
  emit: jest.fn(() => ({ defaultPrevented: false })),
  navigate: jest.fn(),
} as any;

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

function findAllByType(tree: any, type: string): any[] {
  const results: any[] = [];
  function walk(node: any) {
    if (!node) return;
    if (node.type === type) results.push(node);
    if (node.children) {
      for (const child of node.children) {
        if (typeof child === 'object') walk(child);
      }
    }
  }
  walk(tree);
  return results;
}

describe('TabBar', () => {
  function renderTabBar() {
    return render(
      React.createElement(TabBar, {
        state: mockState,
        descriptors: mockDescriptors,
        navigation: mockNavigation,
      }),
    );
  }

  test('renders 4 tab Pressable elements', () => {
    const { toJSON } = renderTabBar();
    const tree = toJSON();
    const pressables = findAllByType(tree, 'Pressable');
    expect(pressables.length).toBe(4);
  });

  test('renders HOME label', () => {
    const { getByText } = renderTabBar();
    expect(getByText('HOME')).toBeTruthy();
  });

  test('renders all tab labels', () => {
    const { getByText } = renderTabBar();
    expect(getByText('HOME')).toBeTruthy();
    expect(getByText('BRIEFS')).toBeTruthy();
    expect(getByText('BOARD')).toBeTruthy();
    expect(getByText('LIBRARY')).toBeTruthy();
  });

  test('renders icon components for each tab', () => {
    const { toJSON } = renderTabBar();
    const tree = toJSON();
    const mics = findAllByType(tree, 'Mic');
    const newspapers = findAllByType(tree, 'Newspaper');
    const squarePens = findAllByType(tree, 'SquarePen');
    const libraries = findAllByType(tree, 'Library');
    expect(mics.length).toBe(1);
    expect(newspapers.length).toBe(1);
    expect(squarePens.length).toBe(1);
    expect(libraries.length).toBe(1);
  });
});
