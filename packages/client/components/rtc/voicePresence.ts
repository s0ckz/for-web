import type { Channel, Client } from "stoat.js";

/**
 * Reconcile the local user's voice presence across all known channels.
 *
 * The server only learns about a voice channel switch once it processes
 * `VoiceChannelLeave`/`VoiceChannelMove`, which can lag the client's own
 * action by several seconds. In the meantime the sidebar would show the
 * local user as still present in the channel they just left. We don't
 * need to wait: the client can only ever be in one voice channel at a
 * time, so it already knows for certain it is no longer in any channel
 * other than the one it just joined (or none, if it just disconnected).
 *
 * This only ever removes the local user from `voiceParticipants` maps —
 * it never adds them to `channel`. Removal can't be wrong (we know we
 * left), but adding could race ahead of the server and show the user in
 * a channel they failed to join. Only the server's `VoiceChannelJoin` /
 * `VoiceChannelMove` events are allowed to add participants.
 *
 * Lives here rather than on the SDK `Client` because `stoat.js` is an
 * upstream git submodule this repo cannot push changes to -- everything
 * needed is already public from app code (`Channel.voiceParticipants` is
 * a public `ReactiveMap`, `client.channels.values()` a public iterator).
 * @param client The current client
 * @param channel The voice channel the local user is now in, if any
 */
export function reconcileLocalVoicePresence(
  client: Client,
  channel?: Channel,
): void {
  const selfId = client.user?.id;
  if (!selfId) return;

  for (const known of client.channels.values()) {
    if (known.id !== channel?.id) {
      known.voiceParticipants.delete(selfId);
    }
  }
}
