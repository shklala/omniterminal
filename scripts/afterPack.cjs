// electron-builder afterPack hook: drop Chromium files OmniTerminal never uses.
// dxcompiler.dll / dxil.dll are the DirectX shader compiler used only by WebGPU (Dawn).
// The terminal renders with WebGL (ANGLE uses d3dcompiler_47.dll, which is kept).
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  for (const f of ['dxcompiler.dll', 'dxil.dll']) {
    const p = path.join(context.appOutDir, f);
    if (fs.existsSync(p)) {
      fs.rmSync(p);
      console.log(`  • afterPack removed ${f}`);
    }
  }
};
