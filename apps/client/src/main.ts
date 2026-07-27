import "./styles.css";
import { GameApp } from "./GameApp";
import { ui } from "./ui";

const canvas = document.getElementById("renderCanvas");
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error("Missing #renderCanvas");
}

const app = new GameApp(canvas);

ui.onFloor((floor) => app.setFloor(floor));
ui.onMode((mode) => void app.setMode(mode));
ui.onHire((type) => void app.hire(type));

void app.start().catch((error) => {
  console.error(error);
  ui.showToast("INITIALIZATION FAILED");
});
