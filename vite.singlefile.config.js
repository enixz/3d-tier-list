import { viteSingleFile } from 'vite-plugin-singlefile';

// 便携版构建:把 3D 版打包成单个 HTML 文件,双击即可在浏览器打开
export default {
  base: './',
  plugins: [viteSingleFile()],
  build: {
    outDir: 'dist-single',
  }
};
