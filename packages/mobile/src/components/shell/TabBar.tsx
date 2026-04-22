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
            const event = navigation.emit({
              type: 'tabPress',
              target: state.routes[idx]?.key,
            });
            if (!event.defaultPrevented) {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              navigation.navigate(routeName);
            }
          };

          if (tab.isHero) {
            return (
              <Pressable
                key={tab.name}
                onPress={onPress}
                style={styles.heroWrap}
                accessibilityRole="button"
              >
                <View
                  style={[
                    styles.heroCircle,
                    {
                      backgroundColor: isActive
                        ? colors.accent
                        : colors.iconBg,
                      shadowColor: isActive ? colors.accent : 'transparent',
                      shadowOpacity: isActive ? 0.4 : 0,
                      shadowRadius: 12,
                      shadowOffset: { width: 0, height: 4 },
                    },
                  ]}
                >
                  <tab.Icon
                    size={22}
                    strokeWidth={1.8}
                    color={isActive ? '#FFFFFF' : colors.ink}
                  />
                </View>
                <Text
                  style={[
                    styles.label,
                    {
                      fontFamily: fonts.mono,
                      color: isActive ? colors.accent : colors.secondary,
                    },
                  ]}
                >
                  {tab.label}
                </Text>
              </Pressable>
            );
          }

          return (
            <Pressable
              key={tab.name}
              onPress={onPress}
              style={styles.tab}
              accessibilityRole="button"
            >
              <tab.Icon
                size={22}
                strokeWidth={isActive ? 1.8 : 1.4}
                color={
                  isActive
                    ? colors.ink
                    : theme.dark
                      ? '#626260'
                      : colors.secondary
                }
              />
              <Text
                style={[
                  styles.label,
                  {
                    fontFamily: fonts.mono,
                    fontWeight: isActive ? '500' : '400',
                    color: isActive
                      ? colors.ink
                      : theme.dark
                        ? '#626260'
                        : colors.secondary,
                  },
                ]}
              >
                {tab.label}
              </Text>
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
