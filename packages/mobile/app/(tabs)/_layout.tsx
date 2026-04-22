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
