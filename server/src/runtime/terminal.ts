export const minecraftTerminalProfile = {
  tty: true,
  env: ["TERM=xterm-256color", "COLORTERM=truecolor"]
} as const;

export type MinecraftTerminalProfile = {
  tty: boolean;
  env: readonly string[];
};

export function minecraftTerminalContainerConfig() {
  return {
    Tty: minecraftTerminalProfile.tty,
    Env: [...minecraftTerminalProfile.env]
  };
}

export function minecraftTerminalConfigFingerprint(profile: MinecraftTerminalProfile = minecraftTerminalProfile) {
  return JSON.stringify({ tty: profile.tty, env: [...profile.env] });
}
