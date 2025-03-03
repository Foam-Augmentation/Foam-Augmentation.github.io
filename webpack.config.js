const path = require('path');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyPlugin = require('copy-webpack-plugin');


module.exports = {
    mode: 'development',
    entry: './src/index.ts',  // the main TypeScript file of the app
    devtool: 'eval-source-map',
    output: {
        path: path.resolve(__dirname, 'dist'), // output directory
        filename: 'bundle.js', // the compiled JavaScript file
    },
    resolve: {
        extensions: ['.ts', '.js'], // resolve TypeScript and JavaScript files
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