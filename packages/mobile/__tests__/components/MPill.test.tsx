import React from 'react';
import { create, act, ReactTestRenderer } from 'react-test-renderer';

// Mock react-native with enough fidelity for component rendering.
jest.mock('react-native', () => {
  const R = require('react');
  return {
    View: 'View',
    Text: 'Text',
    Pressable: ({ children, ...rest }: any) =>
      R.createElement('Pressable', rest, children),
    StyleSheet: {
      create: (styles: any) => styles,
      hairlineWidth: 0.5,
    },
    Platform: { OS: 'ios', select: (obj: any) => obj.ios },
    useColorScheme: jest.fn(() => 'light'),
  };
});

// Must import after mocks are set up
const { MPill } = require('../../src/components/primitives/MPill');

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

describe('MPill', () => {
  test('renders text content with default neutral tone', () => {
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(MPill, {}, 'Decision'));
    });
    const tree = renderer!.toJSON();
    const texts = findAllText(tree);
    expect(texts).toContain('Decision');
  });

  test('renders with accent tone', () => {
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(MPill, { tone: 'accent' }, 'Important'));
    });
    const tree = renderer!.toJSON();
    const texts = findAllText(tree);
    expect(texts).toContain('Important');
  });

  test('renders with success tone', () => {
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(MPill, { tone: 'success' }, 'Complete'));
    });
    const tree = renderer!.toJSON();
    const texts = findAllText(tree);
    expect(texts).toContain('Complete');
  });

  test('renders with warn tone', () => {
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(MPill, { tone: 'warn' }, 'Blocked'));
    });
    const tree = renderer!.toJSON();
    const texts = findAllText(tree);
    expect(texts).toContain('Blocked');
  });

  test('pill has a View root with Text child', () => {
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(MPill, {}, 'Test'));
    });
    const tree = renderer!.toJSON() as any;
    // Root should be a View (pill container)
    expect(tree.type).toBe('View');
    // Should contain a Text element
    const textNodes = findAllByType(tree, 'Text');
    expect(textNodes.length).toBe(1);
  });
});
