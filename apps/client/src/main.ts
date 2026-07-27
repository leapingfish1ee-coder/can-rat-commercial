import "./styles.css";
import { GameApp } from "./GameApp";
import { installQualityPhysicsPolicy } from "./qualityPhysicsPolicy";
import { installRenderPolicy } from "./renderPolicy";
import { installResourceLifecyclePolicy } from "./resourceLifecyclePolicy";
import { ui } from "./ui";

const canvas = document.getElementById("renderCanvas");
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error("Missing #renderCanvas");
}

installResourceLifecyclePolicy();
const app = new GameApp(canvas);
(globalThis as typeof globalThis & { __CAN_RAT_APP__?: GameApp }).__CAN_RAT_APP__ = app;
installQualityPhysicsPolicy(app);
installRenderPolicy(app);

ui.onFloor((floor) => app.setFloor(floor));
ui.onMode((mode) => void app.setMode(mode));
ui.onHire((type) => void app.hire(type));

void app.start().catch((error) => {
  console.error(error);
  ui.showToast("INITIALIZATION FAILED");
});
