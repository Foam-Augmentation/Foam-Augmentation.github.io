const path = require('path');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = {
    mode: 'development',
    entry: './src/index.js',  // the main JavaScript file of the app
    devtool: 'eval-source-map',
    output: {
        path: path.resolve(__dirname, 'dist'), // output directory
        filename: 'bundle.js', // the compiled JavaScript file
    },
    module: {
        rules: [
            {
                test: /\.css$/, // handle CSS files
                use: [MiniCssExtractPlugin.loader, 'css-loader'],
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
    ],
};