// 楊竹科技 — Three.js 3D 預覽模組（圓角卡片版）

let scene, camera, renderer, mesh3d, animFrame;
let isAnimating = false;
let patternDecalMesh = null; // 黑卡：圖案獨立浮雕層（掛在 mesh3d 底下，隨卡片一起旋轉）

// 黑卡圖案浮雕層依印刷效果調整的參數：
// zOffset＝浮雕凸起高度；color＝圖案本身的顏色，壓在 #1f1f1f~#262626 之間——
// 比卡體（0x0a0a0a）略亮到足以看出浮雕層次，但不能太亮，否則會變成銀灰貼紙感，
// 失去「黑色壓紋」的質感；bumpScale＝依圖案明暗換算出法線凹凸，是讓邊緣、
// 眼睛、耳朵線條在光線下出現亮黑高光/陰影的關鍵；roughness/clearcoat 控制
// 圖案本身光澤，讓五種工藝的浮雕強度有明顯區隔。
const BLACK_CARD_DECAL_PARAMS = {
  gloss_black:           { zOffset: 0.012, color: 0x1f1f1f, roughness: 0.28, clearcoat: 0.7,  clearcoatRoughness: 0.1,  bumpScale: 0.090 },
  matte_black:           { zOffset: 0.012, color: 0x1f1f1f, roughness: 0.45, clearcoat: 0.5,  clearcoatRoughness: 0.3,  bumpScale: 0.080 },
  emboss_black_light:    { zOffset: 0.015, color: 0x212121, roughness: 0.45, clearcoat: 0.55, clearcoatRoughness: 0.25, bumpScale: 0.100 },
  emboss_black_standard: { zOffset: 0.017, color: 0x242424, roughness: 0.45, clearcoat: 0.6,  clearcoatRoughness: 0.2,  bumpScale: 0.120 },
  emboss_black_deep:     { zOffset: 0.020, color: 0x1f1f1f, roughness: 0.45, clearcoat: 0.48, clearcoatRoughness: 0.15, bumpScale: 0.140 }
};

// 清掉黑卡圖案浮雕層（含它額外烘的 alphaMap/bumpMap 貼圖），避免切換工藝/重建卡片時貼圖累積洩漏
function disposePatternDecal() {
  if (!patternDecalMesh) return;
  if (patternDecalMesh.parent) patternDecalMesh.parent.remove(patternDecalMesh);
  const m = patternDecalMesh.material;
  if (m) {
    if (m.map) m.map.dispose();
    if (m.alphaMap) m.alphaMap.dispose();
    if (m.bumpMap) m.bumpMap.dispose();
    m.dispose();
  }
  patternDecalMesh.geometry.dispose();
  patternDecalMesh = null;
}

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
  // 開Tone Mapping：沒開的話，只要某個角度算出來的反光強度超過最大值就會直接死白，
  // 把貼圖顏色整個蓋掉（保溫杯正面中央剛好卡到主光源反光角度，深色蝕刻文字因此完全
  // 看不到，見保溫杯藝術簽名相關討論）。開了之後過亮的反光會自然收斂成漸層亮部，
  // 不會再整片死白，同時讓所有商品的3D預覽反光質感更自然。
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
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

  if (finishId === 'matte' || finishId === 'matte_black') {
    // 霧面／黑卡霧黑：高粗糙度，幾乎無鏡面反射，視覺柔和平坦
    mat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0.0 });

  } else if (finishId && finishId.startsWith('emboss_black')) {
    // 黑卡浮雕：中低粗糙度 + 適度清漆層，呈現浮雕邊緣的層次感
    mat = new THREE.MeshPhysicalMaterial({
      roughness: 0.35,
      metalness: 0.05,
      clearcoat: 0.5,
      clearcoatRoughness: 0.25
    });

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
// onComplete（選填）：畫面真正完成渲染時呼叫（貼圖是非同步的<img>.onload，沒有texture
// 時則是同步完成），供事件追蹤用來判斷preview_complete的真正完成時機，不影響原本邏輯。
function buildCard(textureDataURL, finishId, onComplete) {
  // finishId 未傳入時從 STATE 取得
  if (!finishId && typeof STATE !== 'undefined') finishId = STATE.finishId;
  finishId = finishId || 'gloss';

  // 清除舊物件（含黑卡圖案浮雕層，它是掛在 mesh3d 底下的 child mesh）
  if (mesh3d) {
    scene.remove(mesh3d);
    if (mesh3d.geometry) mesh3d.geometry.dispose();
    const mats = Array.isArray(mesh3d.material) ? mesh3d.material : [mesh3d.material];
    mats.forEach(m => m && m.dispose());
    mesh3d = null;
  }
  disposePatternDecal();

  const p      = (typeof STATE !== 'undefined' && STATE.productId && PRODUCTS[STATE.productId])
                  ? PRODUCTS[STATE.productId]
                  : PRODUCTS['easycard'];
  const aspect = p.size.w / p.size.h;   // 85.6/54 ≈ 1.585
  const cardW  = 2.4;
  const cardH  = cardW / aspect;
  const cardD  = 0.036;
  const cardBevelThickness = 0.007; // ExtrudeGeometry 導角厚度：正面實際最外緣是 cardD/2 + 這個值，不是 cardD/2
  const radius = 0.12;

  const shape = makeRoundedRect(cardW, cardH, radius);
  const geo   = new THREE.ExtrudeGeometry(shape, {
    depth:          cardD,
    bevelEnabled:   true,
    bevelSegments:  4,
    bevelSize:      0.007,
    bevelThickness: cardBevelThickness,
    steps:          1,
    curveSegments:  10
  });
  geo.translate(0, 0, -cardD / 2);

  const isBlackCard = p.id === 'black_card';

  // 側面材質
  const sideMat = new THREE.MeshStandardMaterial({
    color: isBlackCard ? 0x141414 : 0xcccccc, roughness: 0.75, metalness: 0.05
  });

  let frontMat;

  if (isBlackCard) {
    // 黑卡卡體固定為霧黑磨砂材質，不再把整張設計合成圖（含底圖+圖案）當成卡面 texture ——
    // 圖案改由 attachBlackCardPatternDecal() 疊一層獨立的浮雕 mesh，才會有真正的立體浮雕感，
    // 而不是像貼紙一樣平貼在卡面上。
    frontMat = new THREE.MeshPhysicalMaterial({
      color: 0x0a0a0a,
      roughness: 0.88,
      metalness: 0.05,
      clearcoat: 0.05,
      clearcoatRoughness: 0.6
    });

  } else if (textureDataURL) {
    // 悠遊卡／一卡通：依實際工藝（亮面/霧面/局部UV）疊材質層次再貼設計合成圖，取代完全
    // 平光、無材質反應的 MeshBasicMaterial，讓正視/微斜視角能看出對應工藝的粗糙度/光澤
    // 層次，而不是像貼紙貼上去。只限這兩個同構卡片商品——USB等其餘商品本次不列入修改
    // 範圍，維持原本的平光貼圖邏輯，避免共用函式的調整意外改變它們既有的成品預覽畫面。
    frontMat = ['easycard', 'ipass'].includes(p.id) ? makeFinishMaterial(finishId, null) : new THREE.MeshBasicMaterial();
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
      if (typeof onComplete === 'function') onComplete(); // 貼圖真正套用完成，這裡才算真的畫完
    };
    img.src = textureDataURL;

  } else {
    // 無設計圖：用 PBR 材質顯示材質感 + 產品主色
    frontMat = makeFinishMaterial(finishId, null);
    if (frontMat.color) frontMat.color = new THREE.Color(safeCssColor(p.color, '#999999'));
  }

  const backMat = new THREE.MeshStandardMaterial({
    color: isBlackCard ? 0x0a0a0a : 0xe8ecf0, roughness: 0.55
  });

  // 材質群組：[0]=頂面(朝相機), [1]=側面, [2]=底面(背對相機)
  mesh3d = new THREE.Mesh(geo, [frontMat, sideMat, backMat]);
  mesh3d.castShadow = true;
  scene.add(mesh3d);

  if (isBlackCard) {
    attachBlackCardPatternDecal(mesh3d, cardW, cardH, cardD / 2 + cardBevelThickness, finishId);
  }
  // 黑卡（材質同步設定完成）與「沒有設計圖」這兩種情況都沒有非同步貼圖載入要等，
  // mesh加進場景當下就算真的畫完；有設計圖且非黑卡的情況已經在上面img.onload裡呼叫過。
  if ((isBlackCard || !textureDataURL) && typeof onComplete === 'function') onComplete();
}

// ─── 黑卡：圖案獨立浮雕層 ─────────────────────────────────────
// 用一片獨立的 PlaneGeometry 疊在卡面正前方（z 略高於卡面），掛在卡片 mesh 底下
// 讓它自動隨卡片一起旋轉。材質用 alphaMap 讓只有圖案本身區域顯示，其餘透明，
// 露出底下的霧黑卡體，搭配 clearcoat 讓圖案邊緣/五官線條隨光線出現亮黑高光。
// frontZ：卡面正面實際最外緣的本地 z 座標（已含導角厚度，見呼叫端 cardD/2 + cardBevelThickness）
function attachBlackCardPatternDecal(hostMesh, cardW, cardH, frontZ, finishId) {
  disposePatternDecal();

  const dataURL = (typeof STATE !== 'undefined') ? STATE.blackCardPatternDataURL : null;
  if (!dataURL) return;

  const params = BLACK_CARD_DECAL_PARAMS[finishId] || BLACK_CARD_DECAL_PARAMS.gloss_black;

  new THREE.TextureLoader().load(dataURL, tex => {
    tex.encoding  = THREE.sRGBEncoding;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;

    // three.js 的 alphaMap 讀的是貼圖顏色的綠色色版，不是 PNG 真正的 alpha 通道——
    // 直接把去背圖拿來當 alphaMap，去背區域殘留的顏色一旦綠色分量不是 0，就會被誤判成
    // 不透明，整塊矩形跟著顯示出來（浮雕看起來像貼了一張方形貼紙）。這裡另外烘一張
    // 「顏色＝原圖真實 alpha 值」的貼圖專門給 alphaMap 用，才能正確裁切成圖案本身的形狀。
    const srcImg = tex.image;
    const aCanvas = document.createElement('canvas');
    aCanvas.width  = srcImg.width;
    aCanvas.height = srcImg.height;
    const actx = aCanvas.getContext('2d');
    actx.drawImage(srcImg, 0, 0);
    const idata = actx.getImageData(0, 0, aCanvas.width, aCanvas.height);
    const ad = idata.data;
    for (let i = 0; i < ad.length; i += 4) {
      const a = ad[i + 3];
      ad[i] = ad[i + 1] = ad[i + 2] = a;
      ad[i + 3] = 255;
    }
    actx.putImageData(idata, 0, 0);
    const alphaTex = new THREE.CanvasTexture(aCanvas);
    alphaTex.minFilter = THREE.LinearFilter;
    alphaTex.magFilter = THREE.LinearFilter;

    // 依圖案真實長寬比置中縮放：高度佔卡片高度 62%，寬度超過卡片 86% 時改以寬度為準。
    const imgAspect = srcImg.width / srcImg.height;
    const targetHeightRatio = 0.62;
    const maxWidthRatio = 0.86;
    let planeH = cardH * targetHeightRatio;
    let planeW = planeH * imgAspect;
    if (planeW > cardW * maxWidthRatio) {
      planeW = cardW * maxWidthRatio;
      planeH = planeW / imgAspect;
    }

    const geo = new THREE.PlaneGeometry(planeW, planeH);
    const mat = new THREE.MeshPhysicalMaterial({
      // 不用 map（會把圖案本身的暗色再乘上 color，兩層變暗疊加，結果太淡看不清楚）。
      // 圖案的顏色統一用 color 這個比卡體稍亮的平面色，明暗變化改由 bumpMap 換算出的
      // 法線凹凸來呈現，效果才會像「壓印出來的浮雕」而不是一張灰階貼紙。
      alphaMap: alphaTex,
      bumpMap: tex,
      bumpScale: params.bumpScale,
      transparent: true,
      opacity: 1,
      depthWrite: false, // 圖案層跟卡面幾乎貼合，關掉 depthWrite 避免透明區域跟卡體深度互相打架
      side: THREE.DoubleSide, // 保險：不管卡片正面法向量朝哪一側，圖案都會被畫出來
      color: params.color,
      roughness: params.roughness,
      metalness: 0.08,
      clearcoat: params.clearcoat,
      clearcoatRoughness: params.clearcoatRoughness
    });

    const decal = new THREE.Mesh(geo, mat);
    decal.renderOrder = 1;
    decal.position.set(0, 0, frontZ + params.zOffset);

    hostMesh.add(decal);
    patternDecalMesh = decal;

    if (renderer && scene && camera) renderer.render(scene, camera);
  });
}

function makeBlackCardTexturedMaterial(map, finishId) {
  const isMatte = finishId === 'matte_black';
  const isEmboss = finishId && finishId.startsWith('emboss_black');
  return new THREE.MeshPhysicalMaterial({
    map,
    color: 0xffffff,
    roughness: isMatte ? 0.92 : (isEmboss ? 0.62 : 0.48),
    metalness: 0.08,
    clearcoat: isMatte ? 0.06 : 0.32,
    clearcoatRoughness: isMatte ? 0.88 : 0.34,
    reflectivity: isMatte ? 0.18 : 0.42
  });
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

  const isBlackCard = p.id === 'black_card';
  const sideMat = new THREE.MeshStandardMaterial({ color: isBlackCard ? 0x141414 : 0xcccccc, roughness: 0.75, metalness: 0.05 });
  const backMat = new THREE.MeshStandardMaterial({ color: isBlackCard ? 0x0a0a0a : 0xe8ecf0, roughness: 0.55 });

  let frontMat;
  if (canvasEl && canvasEl.width > 0) {
    // 有設計圖：一般彩印卡保持顏色準確；黑卡使用會受光的 PBR 材質。
    const tex = new THREE.CanvasTexture(canvasEl);
    tex.encoding     = THREE.sRGBEncoding;
    tex.minFilter    = THREE.LinearFilter;
    tex.magFilter    = THREE.LinearFilter;
    tex.wrapS        = THREE.RepeatWrapping;
    tex.wrapT        = THREE.RepeatWrapping;
    tex.repeat.set(1 / cardW, 1 / cardH);
    tex.offset.set(0.5, 0.5);
    tex.needsUpdate  = true;
    frontMat = isBlackCard
      ? makeBlackCardTexturedMaterial(tex, finishId)
      : new THREE.MeshBasicMaterial({ map: tex });
  } else {
    // 無設計圖：PBR 材質 + 產品主色
    frontMat = makeFinishMaterial(finishId, null);
    if (frontMat.color) frontMat.color = new THREE.Color(safeCssColor(p.color, '#999999'));
  }

  mesh3d = new THREE.Mesh(geo, [frontMat, sideMat, backMat]);
  mesh3d.castShadow = true;
  scene.add(mesh3d);
}

// ── USB 型：方盒 + 材質效果 ────────────────────────────────────
// 依材質殼（塑膠／金屬／木質）決定機身色澤、光澤度，並貼上程序化產生的材質紋理
// （木紋／髮絲金屬紋），不是只換顏色；依工藝（彩色印刷／雷射雕刻）決定正面圖樣
// 是彩色印刷貼圖，或是壓在材質紋理上的深色蝕刻效果。
const USB_MATERIAL_PARAMS = {
  plastic: { color: 0xececeb, roughness: 0.35, metalness: 0.06, clearcoat: 0.5,  clearcoatRoughness: 0.15 },
  metal:   { color: 0xc3c8cd, roughness: 0.32, metalness: 0.9,  clearcoat: 0.1,  clearcoatRoughness: 0.25 },
  wood:    { color: 0xa06a3c, roughness: 0.58, metalness: 0.0,  clearcoat: 0.22, clearcoatRoughness: 0.45 }
};

// 產生材質本身的程序化紋理（木紋年輪／髮絲金屬拉絲／塑膠素色微噪點），
// 用來讓機身在任何角度都看得出材質差異，而不是只有印刷面才有變化。
function _makeUSBMaterialCanvas(materialId) {
  const cvs = document.createElement('canvas');
  cvs.width = 512; cvs.height = 512;
  const ctx = cvs.getContext('2d');

  if (materialId === 'wood') {
    ctx.fillStyle = '#a9713f';
    ctx.fillRect(0, 0, 512, 512);
    // 水平木紋紋理：多條略帶波浪、深淺交錯的線條模擬年輪紋路
    for (let i = 0; i < 40; i++) {
      const y = (i / 40) * 512 + (Math.sin(i) * 6);
      const shade = i % 3 === 0 ? 'rgba(70,42,18,0.35)' : 'rgba(120,78,40,0.22)';
      ctx.strokeStyle = shade;
      ctx.lineWidth = 1.5 + (i % 4);
      ctx.beginPath();
      for (let x = 0; x <= 512; x += 16) {
        const wobble = Math.sin(x * 0.03 + i) * 5 + Math.sin(x * 0.008 + i * 2) * 8;
        ctx.lineTo(x, y + wobble);
      }
      ctx.stroke();
    }
  } else if (materialId === 'metal') {
    const grad = ctx.createLinearGradient(0, 0, 0, 512);
    grad.addColorStop(0, '#dfe3e6');
    grad.addColorStop(0.5, '#b7bcc1');
    grad.addColorStop(1, '#eef0f2');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 512, 512);
    // 細密水平髮絲紋（brushed metal）
    for (let y = 0; y < 512; y += 2) {
      ctx.strokeStyle = `rgba(255,255,255,${Math.random() * 0.12})`;
      ctx.beginPath();
      ctx.moveTo(0, y + Math.random());
      ctx.lineTo(512, y + Math.random());
      ctx.stroke();
    }
  } else {
    // 塑膠殼：素色搭配極輕微噪點，維持乾淨的塑膠質感
    ctx.fillStyle = '#ececeb';
    ctx.fillRect(0, 0, 512, 512);
    const idata = ctx.getImageData(0, 0, 512, 512);
    for (let i = 0; i < idata.data.length; i += 4) {
      const n = (Math.random() - 0.5) * 6;
      idata.data[i] += n; idata.data[i + 1] += n; idata.data[i + 2] += n;
    }
    ctx.putImageData(idata, 0, 0);
  }
  return cvs;
}

// onComplete（選填）：貼圖真正套用（或確認不需要貼圖）完成時呼叫，供preview_complete
// 事件追蹤使用，不影響原本渲染邏輯。
function buildUSB(finishId, textureDataURL, onComplete) {
  if (!finishId && typeof STATE !== 'undefined') finishId = STATE.finishId;
  finishId = finishId || 'print';
  const materialId = (typeof STATE !== 'undefined' && STATE.materialId) ? STATE.materialId : 'plastic';
  if (!textureDataURL && typeof STATE !== 'undefined') textureDataURL = STATE.designDataURL;

  if (mesh3d) {
    scene.remove(mesh3d);
    if (mesh3d.geometry) mesh3d.geometry.dispose();
    const mats = Array.isArray(mesh3d.material) ? mesh3d.material : [mesh3d.material];
    mats.forEach(m => m && m.dispose());
    mesh3d = null;
  }
  disposePatternDecal();

  const geo = new THREE.BoxGeometry(2.0, 0.6, 0.3);
  const params = USB_MATERIAL_PARAMS[materialId] || USB_MATERIAL_PARAMS.plastic;
  const isLaser = finishId === 'laser';

  const materialCanvas = _makeUSBMaterialCanvas(materialId);
  const materialTex = new THREE.CanvasTexture(materialCanvas);
  materialTex.encoding = THREE.sRGBEncoding;

  // 材質色澤已經直接畫進 materialCanvas 紋理本身，這裡的 color 用中性白即可，
  // 不要再疊一層 params.color 色調——兩層顏色相乘只會讓木紋/髮絲紋整個變暗變濁、
  // 幾乎看不出紋理，跟只換了個深色差不多。
  const bodyMat = () => new THREE.MeshPhysicalMaterial({
    map: materialTex, color: 0xffffff, roughness: params.roughness, metalness: params.metalness,
    clearcoat: params.clearcoat, clearcoatRoughness: params.clearcoatRoughness
  });

  // BoxGeometry 材質群組順序：[+x, -x, +y, -y, +z(朝向相機的正面), -z]。
  // 相機固定在 z=3.8 看向原點，所以印刷面要放在 +z，跟卡片類商品的正面同一側，
  // 放在 +y（頂面）的話會朝上、正面看不到，等同貼圖沒有生效。
  const topMat = new THREE.MeshPhysicalMaterial({
    map: materialTex, color: 0xffffff, roughness: params.roughness, metalness: params.metalness,
    clearcoat: params.clearcoat, clearcoatRoughness: params.clearcoatRoughness
  });

  if (textureDataURL) {
    const _mat = topMat;
    const img = new Image();
    img.onload = function () {
      const cvs = document.createElement('canvas');
      cvs.width = img.width;
      cvs.height = img.height;
      const cctx = cvs.getContext('2d');
      // 先鋪材質紋理當底，讓印刷區以外的機身邊緣也維持材質色澤與紋路
      cctx.drawImage(materialCanvas, 0, 0, cvs.width, cvs.height);
      if (isLaser) {
        // 雷射雕刻：把設計稿轉成深色蝕刻痕跡疊在材質紋理上，而不是完全不印任何內容
        const designCvs = document.createElement('canvas');
        designCvs.width = img.width; designCvs.height = img.height;
        const dctx = designCvs.getContext('2d');
        dctx.drawImage(img, 0, 0);
        const idata = dctx.getImageData(0, 0, designCvs.width, designCvs.height);
        const d = idata.data;
        for (let i = 0; i < d.length; i += 4) {
          const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          // 只留下明顯比背景暗的線條/圖樣當作燒灼痕跡，接近白色的底色視為未雕刻區域（透明）
          const engraveAlpha = lum < 200 ? Math.min(1, (200 - lum) / 140) : 0;
          d[i] = 35; d[i + 1] = 24; d[i + 2] = 14; // 焦黑褐色蝕刻痕
          d[i + 3] = Math.round(engraveAlpha * 230);
        }
        dctx.putImageData(idata, 0, 0);
        cctx.drawImage(designCvs, 0, 0);
      } else {
        // 彩色印刷：設計稿彩色貼圖直接印在材質底上
        cctx.drawImage(img, 0, 0, cvs.width, cvs.height);
      }
      const tex = new THREE.CanvasTexture(cvs);
      tex.encoding = THREE.sRGBEncoding;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      _mat.map = tex;
      _mat.color.set(0xffffff);
      _mat.needsUpdate = true;
      if (renderer && scene && camera) renderer.render(scene, camera);
      if (typeof onComplete === 'function') onComplete();
    };
    img.src = textureDataURL;
  }

  mesh3d = new THREE.Mesh(geo, [bodyMat(), bodyMat(), bodyMat(), bodyMat(), topMat, bodyMat()]);
  mesh3d.castShadow = true;
  scene.add(mesh3d);
  if (!textureDataURL && typeof onComplete === 'function') onComplete();
}

// ── 保溫杯型：圓柱杯身 + 杯蓋/杯底 + 展開印刷稿曲面貼圖 ──────────────────────
// 印刷稿（234×130mm）幾乎繞滿整個杯身圓周（估算杯身圓周≈235mm，兩者幾乎相等），
// 這正是需求裡「接縫區」的由來——貼圖 UV 的 U 軸直接對應圓周角度，repeat(1,1)
// 直接貼滿整個側面，不需要切割局部 UV。

// 雷射雕刻依杯身顏色呈現不同蝕刻色澤（蝕刻是物理去除表面塗層/氧化層，顏色邏輯：
// 金屬原色→蝕刻後露出更深的底材(深灰)；黑色/深色杯身→蝕刻露出底下的銀灰金屬光
// (比杯身亮)；淺色杯身→蝕刻產生的氧化痕跡比底色略深）。roughness 依顏色微調，
// 金屬原色較亮、黑/深色偏啞光。
// alphaMax／roughness 比原本調高：杯身正面中央容易卡到場景燈光的強反光帶，把深色
// 蝕刻紋路曝光洗淡，這裡連同 sideMat 的 metalness（見 buildThermos()）一起調降反光
// 強度、拉高蝕刻對比，避免文字在正面視角被反光蓋過去看不到。
const THERMOS_LASER_ENGRAVE_PARAMS = {
  metal: { r: 58,  g: 54,  b: 50,  alphaMax: 0.92, roughness: 0.6 },
  black: { r: 176, g: 178, b: 182, alphaMax: 0.78, roughness: 0.75 },
  dark:  { r: 138, g: 142, b: 150, alphaMax: 0.80, roughness: 0.75 },
  light: { r: 96,  g: 92,  b: 86,  alphaMax: 0.72, roughness: 0.68 }
};

function _thermosCupColorHex(cupColorId) {
  const list = (typeof PRODUCTS !== 'undefined' && PRODUCTS.thermos && PRODUCTS.thermos.cupColors) || [];
  const found = list.find(c => c.id === cupColorId) || list[0];
  return (found && found.hex) || '#b7bcc1';
}

// 合成杯身側面貼圖：先鋪杯身底色（若杯身圓周略大於印刷稿寬度，剩餘接縫段會露出底色），
// 畫上設計稿，再依 finishId 做雷射蝕刻轉換或彩色印刷曲面壓暗。全程只在這張複製出來的
// 合成 canvas 上操作，不會改動 fabric canvas 上任何物件的座標——get2DDataURL() 匯出的
// dataURL 本身完全不動，直接對應「不能讓曲面效果改變原始圖層位置資料」的要求。
function _makeThermosBodyTexture(img, finishId, cupColorId) {
  const cvs = document.createElement('canvas');
  cvs.width = img.width;
  cvs.height = img.height;
  const ctx = cvs.getContext('2d');
  const hex = _thermosCupColorHex(cupColorId);

  if (finishId === 'laser') {
    // 雷射雕刻：先在暫存 canvas 把設計稿轉成依杯身顏色查表的蝕刻痕跡，再合成回杯身底色上，
    // 蝕刻alpha公式沿用 buildUSB() 同一套亮度門檻（lum<200 才蝕刻，天然有軟邊＝內凹感）。
    const engraveCanvas = document.createElement('canvas');
    engraveCanvas.width = cvs.width; engraveCanvas.height = cvs.height;
    const ectx = engraveCanvas.getContext('2d');
    ectx.drawImage(img, 0, 0, cvs.width, cvs.height);
    const params = THERMOS_LASER_ENGRAVE_PARAMS[cupColorId] || THERMOS_LASER_ENGRAVE_PARAMS.metal;
    const idata = ectx.getImageData(0, 0, cvs.width, cvs.height);
    const d = idata.data;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const engraveAlpha = lum < 200 ? Math.min(1, (200 - lum) / 140) : 0;
      d[i] = params.r; d[i + 1] = params.g; d[i + 2] = params.b;
      d[i + 3] = Math.round(engraveAlpha * params.alphaMax * 255);
    }
    ectx.putImageData(idata, 0, 0);

    ctx.fillStyle = hex;
    ctx.fillRect(0, 0, cvs.width, cvs.height);
    ctx.drawImage(engraveCanvas, 0, 0);
  } else {
    // 彩色印刷：保留原色，鋪底色後直接畫上設計稿（接縫段以外完全保色，不做灰階/蝕刻），
    // 再疊一層左右深、中間淺的固定漸層，模擬杯身曲面朝側後方視覺變暗、避免平貼網頁感。
    ctx.fillStyle = hex;
    ctx.fillRect(0, 0, cvs.width, cvs.height);
    ctx.drawImage(img, 0, 0, cvs.width, cvs.height);
    const grad = ctx.createLinearGradient(0, 0, cvs.width, 0);
    grad.addColorStop(0,    'rgba(0,0,0,0.22)');
    grad.addColorStop(0.2,  'rgba(0,0,0,0)');
    grad.addColorStop(0.8,  'rgba(0,0,0,0)');
    grad.addColorStop(1,    'rgba(0,0,0,0.22)');
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, cvs.width, cvs.height);
    ctx.globalCompositeOperation = 'source-over';
  }
  return cvs;
}

// 清除舊 mesh3d 連同其子物件（杯蓋/杯底/黑卡浮雕層等）的 geometry/material，避免
// 反覆切換視角/工藝/杯身顏色時累積記憶體洩漏——buildCard()/buildUSB() 只清 mesh3d
// 本身（過去沒有子物件需要清），保溫杯新增杯蓋/杯底子物件後改用這支共用清除函式。
function _disposeMesh3DTree() {
  if (!mesh3d) return;
  mesh3d.traverse(obj => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach(m => { if (m) { if (m.map) m.map.dispose(); if (m.bumpMap) m.bumpMap.dispose(); m.dispose(); } });
    }
  });
  scene.remove(mesh3d);
  mesh3d = null;
}

// onComplete（選填）：貼圖真正套用（或確認不需要貼圖）完成時呼叫，供preview_complete
// 事件追蹤使用，不影響原本渲染邏輯。
function buildThermos(finishId, textureDataURL, cupColorId, onComplete) {
  if (!finishId && typeof STATE !== 'undefined') finishId = STATE.finishId;
  finishId = finishId || 'laser';
  if (!textureDataURL && typeof STATE !== 'undefined') textureDataURL = STATE.designDataURL;
  if (!cupColorId && typeof STATE !== 'undefined') cupColorId = STATE.cupColorId;
  cupColorId = cupColorId || 'metal';

  _disposeMesh3DTree();
  disposePatternDecal();

  const radius = 0.45, height = 2.2;
  // openEnded：杯身側面自己不畫上下蓋，杯蓋/杯底另外用獨立幾何疊上去
  const bodyGeo = new THREE.CylinderGeometry(radius, radius, height, 64, 1, true);
  const hex = _thermosCupColorHex(cupColorId);
  const isLaser = finishId === 'laser';
  const engraveParams = THERMOS_LASER_ENGRAVE_PARAMS[cupColorId] || THERMOS_LASER_ENGRAVE_PARAMS.metal;

  // 材質刻意用 MeshStandardMaterial（不用 MeshPhysicalMaterial 的 clearcoat），避免鏡面
  // 高光過強變成塑膠貼紙感；不加 emissive／不混 MeshBasicMaterial，禁止外發光。低調邊緣
  // 高光完全靠場景既有三光源（見 init3DPreview()）+ 這裡的 roughness/metalness 天然產生。
  const sideMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(hex),
    roughness: isLaser ? engraveParams.roughness : 0.55,
    metalness: 0.55
  });

  if (textureDataURL) {
    const _mat = sideMat;
    const img = new Image();
    img.onload = function () {
      const bodyCanvas = _makeThermosBodyTexture(img, finishId, cupColorId);
      const tex = new THREE.CanvasTexture(bodyCanvas);
      tex.encoding = THREE.sRGBEncoding;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.wrapS = THREE.RepeatWrapping;
      tex.repeat.set(1, 1);
      // CylinderGeometry預設UV原點（U=0）落在鏡頭「正面」看到的那一側，但2D設計稿畫布
      // 是把「正中央」當成正面（畫面上「←左側／正面／右側→」的標示、以及兩側「接縫，勿
      // 設計」的斜線區都是照這個假設畫的）。兩邊沒對齊的話，畫布中央的簽名會被貼到杯身
      // 幾乎完全背對鏡頭的那一面，正面反而看到的是「接縫」區域——offset位移0.5剛好把
      // 兩者拉回一致，讓畫布中央＝杯身正面。
      tex.offset.x = 0.5;
      _mat.map = tex;
      _mat.color.set(0xffffff);
      if (isLaser) {
        // 蝕刻alpha通道本身當bump，做出真實凹刻立體感；強度極低避免看起來像貼紙浮雕
        _mat.bumpMap = tex;
        _mat.bumpScale = 0.018;
      }
      _mat.needsUpdate = true;
      if (renderer && scene && camera) renderer.render(scene, camera);
      if (typeof onComplete === 'function') onComplete();
    };
    img.src = textureDataURL;
  }

  mesh3d = new THREE.Mesh(bodyGeo, sideMat);
  mesh3d.castShadow = true;
  scene.add(mesh3d);

  // 杯蓋/杯底：不鏽鋼髮絲紋材質，複用 _makeUSBMaterialCanvas('metal') 既有紋理產生器，
  // 不需要另外設計新的材質紋理。
  const metalTex = new THREE.CanvasTexture(_makeUSBMaterialCanvas('metal'));
  metalTex.encoding = THREE.sRGBEncoding;

  const lidH = height * 0.05;
  const lidGeo = new THREE.CylinderGeometry(radius * 0.92, radius * 0.92, lidH, 64);
  const lidMat = new THREE.MeshPhysicalMaterial({ map: metalTex, color: 0xffffff, roughness: 0.32, metalness: 0.9, clearcoat: 0.15 });
  const lid = new THREE.Mesh(lidGeo, lidMat);
  lid.position.y = height / 2 + lidH / 2;
  lid.castShadow = true;
  mesh3d.add(lid);

  const baseH = height * 0.04;
  const baseGeo = new THREE.CylinderGeometry(radius * 1.02, radius * 0.9, baseH, 64);
  const baseMat = new THREE.MeshPhysicalMaterial({ map: metalTex, color: 0xffffff, roughness: 0.32, metalness: 0.9, clearcoat: 0.15 });
  const base = new THREE.Mesh(baseGeo, baseMat);
  base.position.y = -height / 2 - baseH / 2;
  base.castShadow = true;
  mesh3d.add(base);
  if (!textureDataURL && typeof onComplete === 'function') onComplete();
}

// ── 動畫循環 ────────────────────────────────────────────────
function startAnimation() {
  isAnimating = true;

  // 尊重「減少動態效果」偏好：只渲染一張固定角度的靜止畫面，不啟動旋轉迴圈，
  // 也不會造成全頁截圖時因每格畫面內容不同而重複拼接、按鈕移位。
  const reduceMotion = typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion) {
    if (mesh3d) { mesh3d.rotation.y = -0.35; mesh3d.rotation.x = 0.06; }
    renderer.render(scene, camera);
    return;
  }

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

// ─── 成品預覽視角切換（正視／側視／近拍，一般卡片/USB 商品專用）─────────────
// 只切換 mesh3d 既有的 rotation 與 camera.zoom（PerspectiveCamera 標準縮放屬性），
// 不動 camera.position、不動 buildCard()/buildUSB() 內部任何貼圖/座標換算邏輯，
// 所以不會影響材質貼圖的 UV mapping 或既有的自動旋轉動畫實作方式。
let _standardPreviewAngle = 'front';
function _standardAngleParams(mode) {
  if (mode === 'side')    return { rotY: 0.95, rotX: 0.05, zoom: 1 };
  if (mode === 'left')    return { rotY: -0.95, rotX: 0.05, zoom: 1 }; // 保溫杯專屬：左側
  if (mode === 'right')   return { rotY: 0.95, rotX: 0.05, zoom: 1 };  // 保溫杯專屬：右側（跟side同角度值）
  if (mode === 'closeup') return { rotY: -0.25, rotX: 0.04, zoom: 1.6 };
  return { rotY: 0, rotX: 0, zoom: 1 }; // front（預設）
}
function setStandardPreviewAngle(mode) {
  _standardPreviewAngle = mode;
  document.querySelectorAll('#preview-angle-tools-3d .align-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.angle === mode);
  });
  // 記錄使用者主動選擇的視角，讓重新整理／返回修改／切商品再返回都能維持在同一個角度
  // （見 configurator.js 的 initPreviewStep()）；只有使用者實際點過按鈕才會走到這裡，
  // 全新設計預設不寫入這個值，維持原本自動旋轉展示的體驗。
  if (typeof STATE !== 'undefined') {
    STATE.previewAngle = mode;
    if (typeof scheduleSaveDesign === 'function') scheduleSaveDesign();
  }
  if (!mesh3d || !camera || !renderer) return;
  // 手動選定視角時停止自動旋轉，避免動畫立刻把選好的角度轉走；
  // 三個按鈕（含「正視」）皆為靜止視角，與黑卡 setBlackCardPreviewAngle() 行為一致。
  stopAnimation();
  const p = _standardAngleParams(mode);
  mesh3d.rotation.set(p.rotX, p.rotY, 0);
  camera.zoom = p.zoom;
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);

  const caption = document.getElementById('preview-stage-caption');
  if (caption) caption.textContent = '固定視角展示，點其他角度按鈕可切換';
}

// ── 貼上 2D 設計圖 ────────────────────────────────────────
function applyTexture3D() {
  let dataURL = (typeof get2DDataURL === 'function' && typeof canvas2d !== 'undefined' && canvas2d)
    ? get2DDataURL()
    : null;
  if (!dataURL && typeof STATE !== 'undefined') dataURL = STATE.designDataURL;
  if (!dataURL) return;

  const finishId = (typeof STATE !== 'undefined') ? STATE.finishId : 'gloss';
  if (typeof STATE !== 'undefined' && STATE.productId === 'usb_bar') {
    buildUSB(finishId, dataURL);
  } else if (typeof STATE !== 'undefined' && STATE.productId === 'thermos') {
    buildThermos(finishId, dataURL, STATE.cupColorId);
  } else {
    buildCard(dataURL, finishId);
  }
}

// ── 切換產品形狀 ──────────────────────────────────────────
function switch3DModel(productId) {
  const p = PRODUCTS[productId];
  if (!p) return;
  const finishId = (typeof STATE !== 'undefined') ? STATE.finishId : null;
  if (productId === 'usb_bar') {
    buildUSB(finishId);
  } else if (productId === 'thermos') {
    buildThermos(finishId, null, (typeof STATE !== 'undefined') ? STATE.cupColorId : null);
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
