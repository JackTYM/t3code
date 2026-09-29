import type { MenuAction } from "@react-native-menu/menu";
import { Pressable } from "react-native";

import { SymbolView } from "./AppSymbol";
import { ControlPillMenu } from "./ControlPill";

const CAMERA_ACTION: MenuAction = {
  id: "camera",
  title: "Take Photo or Video",
  image: "camera",
};
const PHOTOS_ACTION: MenuAction = { id: "photos", title: "Photo Library", image: "photo" };
const FILES_ACTION: MenuAction = { id: "files", title: "Choose Files", image: "folder" };

const ATTACHMENT_MENU_ACTIONS: MenuAction[] = [CAMERA_ACTION, PHOTOS_ACTION, FILES_ACTION];
/** Files are a server capability; the camera and the library are not. */
const MEDIA_ONLY_MENU_ACTIONS: MenuAction[] = [CAMERA_ACTION, PHOTOS_ACTION];

export function ComposerAttachmentButton(props: {
  readonly disabled?: boolean;
  readonly supportsFiles: boolean;
  readonly onPickMedia: () => Promise<void>;
  readonly onPickFiles: () => Promise<void>;
  readonly onCaptureMedia: () => Promise<void>;
}) {
  const button = (
    <Pressable
      accessibilityLabel="Add attachment"
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      className="size-[44px] shrink-0 items-center justify-center rounded-full active:opacity-70 disabled:opacity-50"
      disabled={props.disabled}
      onPress={undefined}
    >
      <SymbolView
        name="plus"
        size={20}
        weight="regular"
        tintColorClassName="accent-icon"
        type="monochrome"
      />
    </Pressable>
  );

  if (props.disabled) {
    return button;
  }

  return (
    <ControlPillMenu
      accessible
      accessibilityLabel="Add attachment"
      accessibilityRole="button"
      actions={props.supportsFiles ? ATTACHMENT_MENU_ACTIONS : MEDIA_ONLY_MENU_ACTIONS}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "camera") {
          void props.onCaptureMedia();
        } else if (nativeEvent.event === "photos") {
          void props.onPickMedia();
        } else if (nativeEvent.event === "files") {
          void props.onPickFiles();
        }
      }}
    >
      {button}
    </ControlPillMenu>
  );
}
