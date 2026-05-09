import React from 'react';
import { render } from '@testing-library/react-native';

// Mock react-native with enough fidelity for component rendering.
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
    Pressable: ({ children, ...rest }: any) =>
      R.createElement('Pressable', rest, children),
    StyleSheet: {
      create: (styles: any) => styles,
      flatten: (style: any) => (Array.isArray(style) ? Object.assign({}, ...style) : style ?? {}),
      hairlineWidth: 0.5,
    },
    Platform: { OS: 'ios', select: (obj: any) => obj.ios },
    useColorScheme: jest.fn(() => 'light'),
  };
});

// Must import after mocks are set up
const { MPill } = require('../../src/components/primitives/MPill');

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
    const { getByText } = render(React.createElement(MPill, {}, 'Decision'));
    expect(getByText('Decision')).toBeTruthy();
  });

  test('renders with accent tone', () => {
    const { getByText } = render(React.createElement(MPill, { tone: 'accent' }, 'Important'));
    expect(getByText('Important')).toBeTruthy();
  });

  test('renders with success tone', () => {
    const { getByText } = render(React.createElement(MPill, { tone: 'success' }, 'Complete'));
    expect(getByText('Complete')).toBeTruthy();
  });

  test('renders with warn tone', () => {
    const { getByText } = render(React.createElement(MPill, { tone: 'warn' }, 'Blocked'));
    expect(getByText('Blocked')).toBeTruthy();
  });

  test('pill has a View root with Text child', () => {
    const { toJSON } = render(React.createElement(MPill, {}, 'Test'));
    const tree = toJSON() as any;
    // Root should be a View (pill container)
    expect(tree.type).toBe('View');
    // Should contain a Text element
    const textNodes = findAllByType(tree, 'Text');
    expect(textNodes.length).toBe(1);
  });
});
