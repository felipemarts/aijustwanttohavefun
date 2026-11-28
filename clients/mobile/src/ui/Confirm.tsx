import { Modal, View } from 'react-native';
import { Body, Heading, PixelBox, PixelButton } from './kit';
import { SPACE } from './theme';

export function Confirm({
  visible,
  title,
  body,
  confirm,
  cancel,
  onConfirm,
  onCancel,
  busy,
}: {
  visible: boolean;
  title: string;
  body: string;
  confirm: string;
  cancel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={{ flex: 1, backgroundColor: 'rgba(10,8,14,0.78)', justifyContent: 'center', alignItems: 'center', padding: SPACE.l }}>
        <PixelBox style={{ width: '100%', maxWidth: 440 }} pad={SPACE.l}>
          <View role="alertdialog" aria-label={title}>
            <Heading level={1}>{title}</Heading>
            <Body>{body}</Body>
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: SPACE.s, marginTop: SPACE.l, flexWrap: 'wrap' }}>
              <PixelButton label={cancel} onPress={onCancel} />
              <PixelButton kind="danger" label={confirm} onPress={onConfirm} busy={busy} />
            </View>
          </View>
        </PixelBox>
      </View>
    </Modal>
  );
}
