// 楊竹科技 — Three.js 3D 預覽模組（圓角卡片版）

let scene, camera, renderer, mesh3d, animFrame;
let isAnimating = false;

function init3DPreview(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (typeof THREE === 'undefined') {
    const fallbackImg = (typeof STATE !== 'undefined' && STATE.designDataURL) ? STATE.designDataURL : null;
    container.style = 'display:flex;align-items:center;justify-content:center;min-height:300px;padding:20px;background:#edf2f7;border-radius:12px;';
    container.innerHTML = fallbackImg
      ? `<div style="text-align:center;">
           <img src="${fallbackImg}" alt="設計預覽" style="max-width:100%;max-height:360px;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.15);">
           <p style="font-size:12px;color:#dc2626;margin-top:10px;">⚠️ 3D 預覽載入失敗，暫時顯示平面設計圖。</p>
         </div>`
      : `<p style="color:#dc2626;font-size:14px;">⚠️ 3D 預覽載入失敗，請重新整理頁面再試一次。</p>`;
    return;
  }

  if (renderer) {
    renderer.dispose();
    container.innerHTML = '';
    cancelAnimationFrame(animFrame);
    isAnimating = false;
  }

  const w = container.offsetWidth  || 400;
  const h = container.offsetHeight || 260;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xedf2f7);

  camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 100);
  camera.position.set(0, 0, 3.8);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputEncoding = THREE.sRGBEncoding;
  container.appendChild(renderer.domElement);

  // 環境光（降低以讓材質差異更明顯）
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));

  // 主光（右上）
  const key = new THREE.DirectionalLight(0xffffff, 1.3);
  key.position.set(4, 6, 6);
  key.castShadow = true;
  scene.add(key);

  // 補光（左下）
  const fill = new THREE.DirectionalLight(0xffffff, 0.3);
  fill.position.set(-4, -2, 3);
  scene.add(fill);

  // 背光（強化材質感）
  const back = new THREE.DirectionalLight(0xffffff, 0.35);
  back.position.set(0, 2, -5);
  scene.add(back);

  // 地面陰影接收平面
  const shadowPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(10, 10),
    new THREE.ShadowMaterial({ opacity: 0.12 })
  );
  shadowPlane.rotation.x = -Math.PI / 2;
  shadowPlane.position.y = -0.8;
  shadowPlane.receiveShadow = true;
  scene.add(shadowPlane);

  buildCard(null);
  startAnimation();
}

// ── 依表面工藝建立正面材質 ──────────────────────────────────────
// finishId: 'gloss'(亮面) | 'matte'(霧面) | 'spot_uv'(局部UV) | 'print'(彩色印刷) | 'laser'(雷射雕刻)
function makeFinishMaterial(finishId, tex) {
  let mat;

  if (finishId === 'matte') {
    // 霧面：高粗糙度，幾乎無鏡面反射，視覺柔和平坦
    mat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0.0 });

  } else if (finishId === 'spot_uv') {
    // 局部UV：中等清漆層，有局部亮光感（介於亮霧之間）
    mat = new THREE.MeshPhysicalMaterial({
      roughness: 0.22,
      metalness: 0.05,
      clearcoat: 0.65,
      clearcoatRoughness: 0.18
    });

  } else if (finishId === 'laser') {
    // 雷射雕刻：金屬質感啞光，不貼設計圖
    return new THREE.MeshStandardMaterial({
      roughness: 0.82,
      metalness: 0.42,
      color: 0x909085
    });

  } else {
    // 亮面 (gloss) / 彩色印刷 / 預設：強清漆層，高光明顯，有鏡面感
    mat = new THREE.MeshPhysicalMaterial({
      roughness: 0.06,
      metalness: 0.05,
      clearcoat: 1.0,
      clearcoatRoughness: 0.04
    });
  }

  if (tex) {
    mat.map = tex;
    mat.needsUpdate = true;
  }
  return mat;
}

// ─── 建立圓角卡片 ─────────────────────────────────────────────
function buildCard(textureDataURL, finishId) {
  // finishId 未傳入時從 STATE 取得
  if (!finishId && typeof STATE !== 'undefined') finishId = STATE.finishId;
  finishId = finishId || 'gloss';

  // 清除舊物件
  if (mesh3d) {
    scene.remove(mesh3d);
    if (mesh3d.geometry) mesh3d.geometry.dispose();
    const mats = Array.isArray(mesh3d.material) ? mesh3d.material : [mesh3d.material];
    mats.forEach(m => m && m.dispose());
    mesh3d = null;
  }

  const p      = (typeof STATE !== 'undefined' && STATE.productId && PRODUCTS[STATE.productId])
                  ? PRODUCTS[STATE.productId]
                  : PRODUCTS['easycard'];
  const aspect = p.size.w / p.size.h;   // 85.6/54 ≈ 1.585
  const cardW  = 2.4;
  const cardH  = cardW / aspect;
  const cardD  = 0.036;
  const radius = 0.12;

  const shape = makeRoundedRect(cardW, cardH, radius);
  const geo   = new THREE.ExtrudeGeometry(shape, {
    depth:          cardD,
    bevelEnabled:   true,
    bevelSegments:  4,
    bevelSize:      0.007,
    bevelThickness: 0.007,
    steps:          1,
    curveSegments:  10
  });
  geo.translate(0, 0, -cardD / 2);

  // 側面材質
  const sideMat = new THREE.MeshStandardMaterial({
    color: 0xcccccc, roughness: 0.75, metalness: 0.05
  });

  let frontMat;

  if (textureDataURL) {
    // 有設計圖：用 MeshBasicMaterial 保持顏色 100% 準確
    frontMat = new THREE.MeshBasicMaterial();
    const _mat = frontMat;

    const img = new Image();
    img.onload = function () {
      const cvs = document.createElement('canvas');
      cvs.width  = img.width;
      cvs.height = img.height;
      cvs.getContext('2d').drawImage(img, 0, 0);

      const tex = new THREE.CanvasTexture(cvs);
      tex.encoding  = THREE.sRGBEncoding;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.wrapS     = THREE.RepeatWrapping;
      tex.wrapT     = THREE.RepeatWrapping;
      tex.repeat.set(1 / cardW, 1 / cardH);
      tex.offset.set(0.5, 0.5);

      _mat.map = tex;
      _mat.needsUpdate = true;
      if (renderer && scene && camera) renderer.render(scene, camera);
    };
    img.src = textureDataURL;

  } else {
    // 無設計圖：用 PBR 材質顯示材質感 + 產品主色
    frontMat = makeFinishMaterial(finishId, null);
    if (frontMat.color) frontMat.color = new THREE.Color(p.color);
  }

  const backMat = new THREE.MeshStandardMaterial({
    color: 0xe8ecf0, roughness: 0.55
  });

  // 材質群組：[0]=頂面(朝相機), [1]=側面, [2]=底面(背對相機)
  mesh3d = new THREE.Mesh(geo, [frontMat, sideMat, backMat]);
  mesh3d.castShadow = true;
  scene.add(mesh3d);
}

// ── 建立圓角矩形 Shape ─────────────────────────────────────
function makeRoundedRect(w, h, r) {
  const x = w / 2, y = h / 2;
  const shape = new THREE.Shape();
  shape.moveTo(-x + r, -y);
  shape.lineTo( x - r, -y);
  shape.quadraticCurveTo( x, -y,  x, -y + r);
  shape.lineTo( x,  y - r);
  shape.quadraticCurveTo( x,  y,  x - r,  y);
  shape.lineTo(-x + r,  y);
  shape.quadraticCurveTo(-x,  y, -x,  y - r);
  shape.lineTo(-x, -y + r);
  shape.quadraticCurveTo(-x, -y, -x + r, -y);
  return shape;
}

// ── 同步版：直接以 HTMLCanvasElement 貼卡面（無 img.onload）──
function buildCardSync(canvasEl, finishId) {
  if (!finishId && typeof STATE !== 'undefined') finishId = STATE.finishId;
  finishId = finishId || 'gloss';

  if (mesh3d) {
    scene.remove(mesh3d);
    if (mesh3d.geometry) mesh3d.geometry.dispose();
    const mats = Array.isArray(mesh3d.material) ? mesh3d.material : [mesh3d.material];
    mats.forEach(m => m && m.dispose());
    mesh3d = null;
  }

  const p      = (typeof STATE !== 'undefined' && STATE.productId && PRODUCTS[STATE.productId])
                  ? PRODUCTS[STATE.productId]
                  : PRODUCTS['easycard'];
  const aspect = p.size.w / p.size.h;
  const cardW  = 2.4;
  const cardH  = cardW / aspect;
  const cardD  = 0.036;
  const radius = 0.12;

  const shape = makeRoundedRect(cardW, cardH, radius);
  const geo   = new THREE.ExtrudeGeometry(shape, {
    depth: cardD, bevelEnabled: true, bevelSegments: 4,
    bevelSize: 0.007, bevelThickness: 0.007, steps: 1, curveSegments: 10
  });
  geo.translate(0, 0, -cardD / 2);

  const sideMat = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.75, metalness: 0.05 });
  const backMat = new THREE.MeshStandardMaterial({ color: 0xe8ecf0, roughness: 0.55 });

  let frontMat;
  if (canvasEl && canvasEl.width > 0) {
    // 有設計圖：MeshBasicMaterial 保持顏色準確
    const tex = new THREE.CanvasTexture(canvasEl);
    tex.encoding     = THREE.sRGBEncoding;
    tex.minFilter    = THREE.LinearFilter;
    tex.magFilter    = THREE.LinearFilter;
    tex.wrapS        = THREE.RepeatWrapping;
    tex.wrapT        = THREE.RepeatWrapping;
    tex.repeat.set(1 / cardW, 1 / cardH);
    tex.offset.set(0.5, 0.5);
    tex.needsUpdate  = true;
    frontMat = new THREE.MeshBasicMaterial({ map: tex });
  } else {
    // 無設計圖：PBR 材質 + 產品主色
    frontMat = makeFinishMaterial(finishId, null);
    if (frontMat.color) frontMat.color = new THREE.Color(p.color);
  }

  mesh3d = new THREE.Mesh(geo, [frontMat, sideMat, backMat]);
  mesh3d.castShadow = true;
  scene.add(mesh3d);
}

// ── USB 型：方盒 + 材質效果 ────────────────────────────────────
function buildUSB(finishId) {
  if (!finishId && typeof STATE !== 'undefined') finishId = STATE.finishId;
  finishId = finishId || 'print';

  if (mesh3d) {
    scene.remove(mesh3d);
    if (mesh3d.geometry) mesh3d.geometry.dispose();
    const mats = Array.isArray(mesh3d.material) ? mesh3d.material : [mesh3d.material];
    mats.forEach(m => m && m.dispose());
    mesh3d = null;
  }

  const geo = new THREE.BoxGeometry(2.0, 0.6, 0.3);
  let mat;
  if (finishId === 'laser') {
    // 雷射雕刻：金屬光澤
    mat = new THREE.MeshStandardMaterial({ color: 0x888880, roughness: 0.55, metalness: 0.6 });
  } else {
    // 彩色印刷：略帶光澤的塑膠感
    mat = new THREE.MeshPhysicalMaterial({ color: 0x3a3a3a, roughness: 0.25, metalness: 0.15, clearcoat: 0.4, clearcoatRoughness: 0.2 });
  }
  mesh3d = new THREE.Mesh(geo, mat);
  mesh3d.castShadow = true;
  scene.add(mesh3d);
}

// ── 動畫循環 ────────────────────────────────────────────────
function startAnimation() {
  isAnimating = true;
  let rot = 0;
  function loop() {
    if (!isAnimating) return;
    animFrame = requestAnimationFrame(loop);
    rot += 0.008;
    if (mesh3d) {
      mesh3d.rotation.y = Math.sin(rot) * 0.65;
      mesh3d.rotation.x = Math.sin(rot * 0.5) * 0.14;
    }
    renderer.render(scene, camera);
  }
  loop();
}

function stopAnimation() {
  isAnimating = false;
  cancelAnimationFrame(animFrame);
}

// ── 貼上 2D 設計圖 ────────────────────────────────────────
function applyTexture3D() {
  let dataURL = (typeof get2DDataURL === 'function' && typeof canvas2d !== 'undefined' && canvas2d)
    ? get2DDataURL()
    : null;
  if (!dataURL && typeof STATE !== 'undefined') dataURL = STATE.designDataURL;
  if (!dataURL) return;

  const finishId = (typeof STATE !== 'undefined') ? STATE.finishId : 'gloss';
  buildCard(dataURL, finishId);
}

// ── 切換產品形狀 ──────────────────────────────────────────
function switch3DModel(productId) {
  const p = PRODUCTS[productId];
  if (!p) return;
  const finishId = (typeof STATE !== 'undefined') ? STATE.finishId : null;
  if (productId === 'usb_bar') {
    buildUSB(finishId);
  } else {
    buildCard(null, finishId);
  }
}

// ── Resize ─────────────────────────────────────────────────
function resize3DPreview(containerId) {
  const container = document.getElementById(containerId);
  if (!container || !renderer || !camera) return;
  const w = container.offsetWidth;
  const h = container.offsetHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
