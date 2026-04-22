import { View, Text } from 'react-native';
import { useTheme } from '../../src/theme/theme';

export default function BriefsScreen() {
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
      <Text style={{ color: colors.ink }}>Briefs — M4</Text>
    </View>
  );
}
