// The app's id, read from electron-builder.yml at build time: the installer
// registers the app under its `appId`, and Windows shows (and lets a person
// click) an app's notifications only under that same id, so there's one
// place it's written.
import builderConfig from "../../electron-builder.yml?raw";

/** electron-builder's top-level `appId`, from the config's text. */
export function appIdOf(yaml: string): string {
  const id = /^appId:[ \t]*["']?([^\s"'#]+)/m.exec(yaml)?.[1];
  if (!id) throw new Error("electron-builder.yml has no top-level appId");
  return id;
}

export const APP_ID = appIdOf(builderConfig);
