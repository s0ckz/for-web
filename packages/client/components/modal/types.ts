import { TrackReference } from "solid-livekit-components";
import {
  API,
  Bot,
  Channel,
  Client,
  Emoji,
  File,
  ImageEmbed,
  Message,
  MFA,
  MFATicket,
  ProtocolV1,
  PublicBot,
  PublicChannelInvite,
  Server,
  ServerMember,
  ServerRole,
  Session,
  User,
  VideoEmbed,
} from "stoat.js";

import type { SettingsConfigurations } from "@revolt/app";
import { CategoryData } from "@revolt/app/menus/CategoryContextMenu";
import { ScreenShareQualityName } from "@revolt/state/stores/Voice";

import type { ChangelogResponse } from "./modals/Changelog";

export type Modals =
  | {
      type: "add_bot";
      invite: PublicBot;
    }
  | {
      type: "add_friend";
      client: Client;
    }
  | {
      type: "add_members_to_group";
      client: Client;
      group: Channel;
    }
  | {
      type: "ban_member";
      member: ServerMember;
    }
  | {
      type: "ban_non_member";
      user: User;
      server: Server;
    }
  | {
      type: "changelog";
      changelog: ChangelogResponse;
    }
  | {
      type: "channel_info";
      channel: Channel;
    }
  | {
      type: "channel_toggle_mature";
      channel: Channel;
    }
  | {
      type: "create_bot";
      client: Client;
      onCreate: (bot: Bot) => void;
    }
  | {
      type: "create_category";
      server: Server;
    }
  | {
      type: "create_channel";
      server: Server;
      categoryId?: string;
      cb?: (channel: Channel) => void;
    }
  | {
      type: "create_group";
      client: Client;
    }
  | {
      type: "create_role";
      server: Server;
      callback: (id: string) => void;
    }
  | {
      type: "create_or_join_server";
      client: Client;
    }
  | {
      type: "create_group_or_server";
      client: Client;
    }
  | {
      type: "create_invite";
      channel: Channel;
    }
  | {
      type: "create_server";
      client: Client;
    }
  | {
      type: "create_webhook";
      channel: Channel;
      callback: (id: string) => void;
    }
  | {
      type: "custom_status";
      client: Client;
    }
  | {
      type: "delete_bot";
      bot: Bot;
    }
  | {
      type: "delete_channel";
      channel: Channel;
    }
  | {
      type: "delete_category";
      server: Server;
      categoryId: string;
    }
  | {
      type: "delete_message";
      message: Message;
    }
  | {
      type: "pin_message";
      message: Message;
    }
  | {
      type: "delete_server";
      server: Server;
    }
  | {
      type: "delete_role";
      role: ServerRole;
      cb: () => void;
    }
  | {
      type: "edit_email";
      client: Client;
    }
  | {
      type: "edit_password";
      client: Client;
    }
  | {
      type: "edit_username";
      client: Client;
    }
  | {
      type: "emoji_preview";
      emoji: Emoji;
    }
  | {
      type: "error2";

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      error: any;
    }
  | {
      type: "image_viewer";
      embed?: ImageEmbed;
      gif?: VideoEmbed;
      file?: File;
    }
  | {
      type: "join_server";
      client: Client;
    }
  | {
      type: "kick_member";
      member: ServerMember;
    }
  | {
      type: "leave_server";
      server: Server;
    }
  | {
      type: "mfa_enable_totp";
      identifier: string;
      secret: string;
      callback: (code?: string) => Promise<void>;
      reject?: (reason?: string) => void;
    }
  | ({
      type: "mfa_flow";
    } & (
      | {
          mfa: MFA;
          state: "known";
          callback: (ticket?: MFATicket) => void;
        }
      | {
          state: "unknown";
          available_methods: API.MFAMethod[];
          callback: (response?: API.MFAResponse) => void;
        }
    ))
  | { type: "mfa_recovery"; codes: string[]; mfa: MFA }
  | {
      type: "onboarding";
      callback: (username: string, loginAfterSuccess?: true) => Promise<void>;
    }
  | {
      type: "policy_change";
      changes: ProtocolV1["types"]["policyChange"][];
      acknowledge: () => Promise<void>;
    }
  | {
      type: "rename_session";
      session: Session;
    }
  | {
      type: "report_content";
      client: Client;
      target: Server | User | Message;
      contextMessage?: Message;
    }
  | {
      type: "server_identity";
      member: ServerMember;
    }
  | {
      type: "server_info";
      server: Server;
    }
  | {
      type: "invite";
      invite: PublicChannelInvite;
    }
  | {
      type: "settings";
      config: keyof typeof SettingsConfigurations;
      // eslint-disable-next-line
      context?: any;
    }
  | {
      type: "signed_out";
    }
  | {
      type: "sign_out_sessions";
      client: Client;
    }
  // unimplemented: (modals.tsx#L58)
  | {
      type: "report_success";
      user?: User;
    }
  | {
      type: "out_of_date";
      version: string;
    }
  | {
      type: "reset_bot_token";
      bot: Bot;
    }
  | {
      type: "link_warning";
      url: URL;
      display: string;
    }
  // | {
  //     type: "pending_friend_requests";
  //     users: User[];
  //   }
  | {
      type: "user_picker";
      omit?: string[];
      callback: (users: string[]) => Promise<void>;
    }
  | {
      type: "user_profile";
      user: User;
      isPlaceholder?: boolean;
      placeholderProfile?: API.UserProfile;
      member?: ServerMember;
    }
  | {
      type: "user_profile_roles";
      member: ServerMember;
    }
  | {
      type: "user_profile_mutual_friends";
      users: User[];
      server?: Server;
    }
  | {
      type: "user_profile_mutual_groups";
      groups: (Server | Channel)[];
    }
  | {
      type: "leave_group";
      channel: Channel;
    }
  | {
      type: "close_dm";
      channel: Channel;
    }
  | {
      type: "unfriend_user";
      user: User;
    }
  | {
      type: "block_user";
      user: User;
    }
  | {
      type: "import_theme";
    }
  | {
      type: "edit_category";
      server: Server;
      category: CategoryData;
    }
  | {
      type: "remove_member";
      group: Channel;
      user: User;
    }
  | {
      type: "screen_share_settings";
      trackReference: TrackReference;
      qualities: { name: ScreenShareQualityName; fullName: string }[];
      audio: boolean;
      /**
       * Preselect a quality/audio pair other than the saved default.
       *
       * The saved default is exactly right at share start (the only case
       * that omits these), but wrong for editing a share already running --
       * that needs to seed from what *this* share actually started with
       * (`Voice#lastShareChoice`), which can disagree with the saved
       * default (e.g. a desktop-picker choice made at share start, or an
       * earlier edit).
       */
      initialQualityName?: ScreenShareQualityName;
      initialAudio?: boolean;
      /**
       * Hide "Don't ask me again" and relabel the confirm action for
       * editing a share already running, rather than starting one.
       * "Don't ask me again" writes global "always ask at share start"
       * settings -- offering it from a live-edit menu would be a
       * surprising side effect unrelated to what was just edited.
       */
      liveEdit?: boolean;
      callback: (qualityName: ScreenShareQualityName, audio: boolean) => void;
      onCancel: () => void;
    }
  | {
      type: "screen_share_picker";
      callback: (
        idx: number,
        qualityName: ScreenShareQualityName,
        audio: boolean,
      ) => void;
      qualities: { name: ScreenShareQualityName; fullName: string }[];
      sources: {
        idx: number;
        name: string;
        isFullScreen: boolean;
        image?: string;
      }[];
      onCancel: () => void;
    }
  | {
      type: "edit_bot_username";
      bot: Bot;
    };
