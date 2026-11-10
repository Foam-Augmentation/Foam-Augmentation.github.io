const path = require('path');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = (env, argv) => {
    const isProduction = argv.mode === 'production';

    return {
        mode: isProduction ? 'production' : 'development',
        entry: './src/index.ts',  // the main TypeScript file of the app
        // Full source maps are only useful (and only affordable) in development.
        devtool: isProduction ? false : 'eval-source-map',
        output: {
            path: path.resolve(__dirname, 'dist'), // output directory
            filename: 'bundle.js', // the compiled JavaScript file
            clean: true, // never deploy stale files left over from an earlier build
        },
        resolve: {
            extensions: ['.ts', '.js'], // resolve TypeScript and JavaScript files
        },
        performance: {
            // three.js alone is larger than webpack's default 244 KiB hint.
            maxAssetSize: 2 * 1024 * 1024,
            maxEntrypointSize: 2 * 1024 * 1024,
        },
        module: {
            rules: [
                {
                    test: /\.css$/, // handle CSS files
                    use: [MiniCssExtractPlugin.loader, 'css-loader'],
                },
                {
                    test: /\.ts$/, // handle TypeScript files
                    use: 'ts-loader',
                    exclude: /node_modules/,
                },
            ],
        },
        plugins: [
            new HtmlWebpackPlugin({
                template: './src/index.html', // origin HTML file
            }),
            new MiniCssExtractPlugin({
                filename: 'style.css', // output CSS filename
            }),
            new CopyPlugin({
                patterns: [
                    { from: path.resolve(__dirname, 'src/assets'), to: 'assets' }
                ]
            })
        ],
    };
};
