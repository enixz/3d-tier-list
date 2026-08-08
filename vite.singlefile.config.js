import { viteSingleFile } from 'vite-plugin-singlefile';
import { readFileSync } from 'node:fs';

// 便携版构建:把 3D 版打包成单个 HTML 文件,双击即可在浏览器打开。
// cyber.css 也一并内嵌为禁用的 <style id="cyber-css">,
// 配合 index.html 的 boot 脚本在 file:// 下也能切换皮肤。
// 注意:viteSingleFile 在 generateBundle 阶段才内联样式,
// 所以本插件必须在 generateBundle 里改 HTML,而不是 transformIndexHtml。
function inlineCyberSkin() {
  return {
    name: 'inline-cyber-skin',
    apply: 'build',
    enforce: 'post',
    generateBundle(_, bundle) {
      const key = Object.keys(bundle).find(k => k.endsWith('.html'));
      const asset = key && bundle[key];
      if (!asset || asset.type !== 'asset') throw new Error('index.html asset not found: ' + Object.keys(bundle).join(','));
      const cyber = readFileSync('cyber.css', 'utf8');
      if (cyber.includes('</style>')) throw new Error('cyber.css contains </style>');
      let html = String(asset.source);
      // 按内容(--amber 是 mech 主题变量)定位已内嵌的主样式,避免误匹配注释里的文字
      const styles = [...html.matchAll(/<style[^>]*>[\s\S]*?<\/style>/g)];
      const mech = styles.find(s => s[0].includes('--amber'));
      if (!mech) throw new Error('mech <style> block not found');
      const mechBlock = mech[0].replace('<style', '<style id="mech-css"');
      // singlefile 可能把样式放在 boot 脚本之后,导致 boot 时元素还不存在;
      // 所以把两个样式表都挪到 <head> 最前面(cyber 默认 disabled)
      html = html.replace(mech[0], '');
      html = html.replace(/<head[^>]*>/, (m) => `${m}<style id="cyber-css" disabled>${cyber}</style>${mechBlock}`);
      asset.source = html;
    }
  };
}

export default {
  base: './',
  plugins: [viteSingleFile(), inlineCyberSkin()],
  build: {
    outDir: 'dist-single',
  }
};
