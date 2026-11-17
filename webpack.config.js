const path = require('path');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyPlugin = require('copy-webpack-plugin');

// What the built page may load and run: its own files and nothing else. No inline or evaluated
// script, so text that reaches the page from a preset or a file name cannot run as code. Styles
// may be inline (lil-gui adds its stylesheet that way, with its icon font embedded in it); images
// may be blobs (a gradient SVG the user picks). Only for production builds: the development
// build's source maps use eval.
const CONTENT_SECURITY_POLICY = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
].join('; ');

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
                meta: isProduction
                    ? { 'Content-Security-Policy': { 'http-equiv': 'Content-Security-Policy', content: CONTENT_SECURITY_POLICY } }
                    : {},
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
