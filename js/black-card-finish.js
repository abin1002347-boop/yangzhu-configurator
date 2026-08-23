// 尊爵不凡黑卡材質參數統一來源。
//
// 過去 Step3 設計畫布（fabric.js canvas 端，preview2d.js 的 applyBlackEffectToImage）
// 跟 Step4 成品預覽（純 CSS drop-shadow 端，preview2d.js 的 _drawBlackCardStudioPreview）
// 是完全獨立的兩套渲染管線，各自維護一張參數表，同一個 finishId 在兩邊的欄位、數值
// 完全沒有對應關係（例如 matte_black 在舊的 canvas 表裡 depthRatio 最小，但在舊的
// CSS 表裡 shOff 卻不是最小），兩邊各自調整很容易越調越不一致。
//
// 這裡改成單一「物理描述」來源 BLACK_CARD_FINISHES，canvas 端與 CSS 端的實際渲染參數
// 各自用轉換函式從這裡算出來，兩邊呈現的材質感受才會是同一套邏輯來源、同步變化。
//
// 欄位語意（皆為 0~1 相對強度，不含單位，只在這個檔案內部使用）：
//   embossDepth  浮雕深度／立體感強度（核心區隔淺/標準/深浮雕的變數）
//   highlight    亮部反光強度
//   shadow       暗部陰影強度
//   softness     邊緣柔和度（越高邊緣越模糊委婉／越像霧面漫反射，越低邊緣越銳利分明）
//   baseFill     主體填色不透明度（越低代表底材質噪點越容易透出）
//   specular     是否為鏡面高反光工藝（目前只有亮黑 gloss_black 為 true）
const BLACK_CARD_FINISHES = {
  gloss_black:           { embossDepth: 0.35, highlight: 0.95, shadow: 0.55, softness: 0.15, baseFill: 0.94, specular: true  },
  matte_black:            { embossDepth: 0.28, highlight: 0.30, shadow: 0.45, softness: 0.85, baseFill: 0.78, specular: false },
  emboss_black_light:     { embossDepth: 0.40, highlight: 0.50, shadow: 0.52, softness: 0.60, baseFill: 0.86, specular: false },
  emboss_black_standard:  { embossDepth: 0.65, highlight: 0.65, shadow: 0.68, softness: 0.38, baseFill: 0.92, specular: false },
  emboss_black_deep:      { embossDepth: 0.95, highlight: 0.78, shadow: 0.80, softness: 0.18, baseFill: 0.96, specular: false },
};

// → Step3 設計畫布（fabric.js）合成參數：depthRatio/hiliteOpa/shadowOpa/baseOpacity
// （baseBlend 不在這裡指定，維持呼叫端 applyBlackEffectToImage 原本 `p.baseBlend || 'overlay'`
// 的 fallback 行為，只有滿版紋理那條「直傳自訂參數物件」的路徑才會用到 screen blend）
function blackCardCanvasParams(finishId) {
  const f = BLACK_CARD_FINISHES[finishId] || BLACK_CARD_FINISHES.gloss_black;
  return {
    depthRatio: 0.006 + f.embossDepth * 0.028,
    hiliteOpa:  0.28 + f.highlight * 0.68,
    shadowOpa:  0.25 + f.shadow * 0.45,
    baseOpacity: f.baseFill,
  };
}

// → Step4 成品預覽（CSS drop-shadow）合成參數：base/hiA/hiBlur/shA/shBlur/shOff/specular
function blackCardPreviewParams(finishId) {
  const f = BLACK_CARD_FINISHES[finishId] || BLACK_CARD_FINISHES.gloss_black;
  return {
    base:   0.025 + (1 - f.baseFill) * 0.13,
    hiA:    0.06 + f.highlight * 0.16,
    hiBlur: 0.3 + f.softness * 0.7,
    shA:    0.5 + f.shadow * 0.48,
    shBlur: 0.35 + f.softness * 1.3,
    shOff:  0.4 + f.embossDepth * 1.7,
    specular: f.specular,
  };
}
