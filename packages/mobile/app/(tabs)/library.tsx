import { View, Text } from 'react-native';
import { useTheme } from '../../src/theme/theme';

export default function LibraryScreen() {
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
      <Text style={{ color: colors.ink }}>Library — M8</Text>
    </View>
  );
}
