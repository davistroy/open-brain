import React from 'react';
import { create, act, ReactTestRenderer } from 'react-test-renderer';

// Mock react-native with enough fidelity for component rendering.
// jest.mock factories cannot reference outer-scope variables, so we use
// require() inside each factory for React references.
jest.mock('react-native', () => {
  const R = require('react');
  return {
    View: 'View',
    Text: 'Text',
    Pressable: ({ children, accessibilityRole, ...rest }: any) =>
      R.createElement('Pressable', { accessibilityRole, ...rest }, children),
    StyleSheet: {
      create: (styles: any) => styles,
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

function findAllText(tree: any): string[] {
  const results: string[] = [];
  function walk(node: any) {
    if (!node) return;
    if (typeof node === 'string') {
      results.push(node);
      return;
    }
    if (node.children) {
      for (const child of node.children) {
        walk(child);
      }
    }
  }
  walk(tree);
  return results;
}

describe('TabBar', () => {
  let renderer: ReactTestRenderer;

  beforeEach(() => {
    act(() => {
      renderer = create(
        React.createElement(TabBar, {
          state: mockState,
          descriptors: mockDescriptors,
          navigation: mockNavigation,
        }),
      );
    });
  });

  test('renders 4 tab Pressable elements', () => {
    const tree = renderer.toJSON();
    const pressables = findAllByType(tree, 'Pressable');
    expect(pressables.length).toBe(4);
  });

  test('renders HOME label', () => {
    const tree = renderer.toJSON();
    const texts = findAllText(tree);
    expect(texts).toContain('HOME');
  });

  test('renders all tab labels', () => {
    const tree = renderer.toJSON();
    const texts = findAllText(tree);
    expect(texts).toContain('HOME');
    expect(texts).toContain('BRIEFS');
    expect(texts).toContain('BOARD');
    expect(texts).toContain('LIBRARY');
  });

  test('renders icon components for each tab', () => {
    const tree = renderer.toJSON();
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
