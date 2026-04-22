import { View, Text } from 'react-native';
import { useTheme } from '../../src/theme/theme';

export default function HomeScreen() {
  const { colors } = useTheme();
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.bg,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ color: colors.ink }}>Home — M1</Text>
    </View>
  );
}
