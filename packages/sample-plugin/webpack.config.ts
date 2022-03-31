/* eslint-disable @typescript-eslint/no-non-null-assertion */
import path from 'path';
import { DynamicRemotePlugin } from '@openshift/dynamic-plugin-sdk-webpack';
import type { Configuration } from 'webpack';
import extensions from './plugin-extensions';

const config: Configuration = {
  mode: 'development',
  entry: {}, // plugin container entry generated by DynamicRemotePlugin
  output: {
    path: path.resolve(__dirname, 'dist'),
    publicPath: '/sample-plugin/',
    chunkFilename: 'chunks/[id].js',
    assetModuleFilename: 'assets/[name][ext]',
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.jsx'],
  },
  module: {
    rules: [
      {
        test: /\.(jsx?|tsx?)$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader',
            options: {
              configFile: path.resolve(__dirname, 'tsconfig.json'),
            },
          },
        ],
      },
      {
        test: /\.(css)$/,
        use: ['style-loader', 'css-loader'],
      },
      {
        test: /\.(png|jpg|jpeg|gif|svg|woff2?|ttf|eot|otf)$/,
        type: 'asset/resource',
      },
    ],
  },
  plugins: [
    new DynamicRemotePlugin({
      extensions,
    }),
  ],
  devtool: 'source-map',
  optimization: {
    chunkIds: 'named',
    minimize: false,
  },
};

if (process.env.NODE_ENV === 'production') {
  config.mode = 'production';
  config.output!.chunkFilename = 'chunks/[id]-[chunkhash].min.js';
  config.output!.assetModuleFilename = 'assets/[hash][ext]';
  config.optimization!.chunkIds = 'deterministic';
  config.optimization!.minimize = true;
}

export default config;
