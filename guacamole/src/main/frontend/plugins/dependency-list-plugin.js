/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

const finder = require('find-package-json');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const validateOptions = require('schema-utils');

/**
 * The name of this plugin.
 *
 * @type {string}
 */
const PLUGIN_NAME = 'dependency-list-plugin';

/**
 * The schema of the configuration options object accepted by the constructor
 * of DependencyListPlugin.
 *
 * @see https://github.com/webpack/schema-utils/blob/v1.0.0/README.md#usage
 */
const PLUGIN_OPTIONS_SCHEMA = {
    type: 'object',
    properties: {

        /**
         * The name of the file that should contain the dependency list. By
         * default, this will be "npm-dependencies.txt".
         */
        filename: { type: 'string' },

        /**
         * The name of the file that should contain the generated SBOM. By
         * default, this will be "npm-sbom.json".
         */
        sbomFilename: { type: 'string' },

        /**
         * The path in which the dependency list file should be saved. By
         * default, this will be the output path of the Webpack compiler.
         */
        path: { type: 'string' }

    },
    additionalProperties: false
};

/**
 * Webpack plugin that automatically lists each of the NPM dependencies
 * included within any bundles produced by the compile process.
 */
class DependencyListPlugin {

    /**
     * Creates a new DependencyListPlugin configured with the given options.
     * The options given must conform to the options schema.
     *
     * @see PLUGIN_OPTIONS_SCHEMA
     *
     * @param {*} options
     *     The configuration options to apply to the plugin.
     */
    constructor(options = {}) {
        validateOptions(PLUGIN_OPTIONS_SCHEMA, options, 'DependencyListPlugin');
        this.options = options;
    }

    /**
     * Attempts to locate the NPM package that provided the given file. If no
     * such package exists, undefined is returned.
     *
     * @private
     * @param {string} file
     *    The filename of the file whose NPM package should be located.
     *
     * @return {*}
     *     The NPM package object associated with the given file, or undefined
     *     if no such package exists.
     */
    static #findPackage(file) {

        const moduleFinder = finder(file);

        // Find first module associated with given file, which may not actually
        // the module in question (some NPM dependencies may include multiple
        // package.json files, with the relevant package.json being further up
        // in the directory tree)
        let currentModule = moduleFinder.next();

        // Continue searching up through the directory tree until the relevant
        // package.json file has been located (based on the presence of a
        // declared name) OR until we run out of packages to check
        while (!currentModule.done && !currentModule.value?.name)
            currentModule = moduleFinder.next();

        // This will either be a valid package object or undefined if no
        // package could be located
        return currentModule.value;

    }

    /**
     * Converts the authorship information of the "author" property of an NPM
     * package into the corresponding information used by CycloneDX SBOMs via
     * the "authors" property of the v1.6 specification.
     *
     * @private
     * @param {string|*} npmAuthor
     *     The value of the "author" property of an NPM package, which may be
     *     an structured object or a shorthand string.
     *
     * @return {Object[]}
     *     A valid value for the "authors" property of the CycloneDX v1.6 SBOM
     *     specification, containing the same information as provided from NPM
     *     wherever possible.
     */
    static #toSBOMAuthors(npmAuthor) {

        let values;
        let author = {};

        // Use structured authorship information where present
        if (npmAuthor.name) {

            author.name = npmAuthor.name;

            if (npmAuthor.email)
                author.email = npmAuthor.email;

        }

        // NPM also permits authorship information to be represented as a
        // shorthand string of the form "NAME <email> (URL)"
        else if ((values = /^(.*?)\s*(?:<([^>]*)>)?\s*(?:\(([^)]*)\))?$/.exec(npmAuthor))) {

            author.name = values[1];

            if (values[2])
                author.email = values[2];

        }

        // Assume all other formats are simply the author's name
        else
            author.name = npmAuthor;

        return [ author ];

    }

    /**
     * Converts the license information of the "license" property of an NPM
     * package into the corresponding information used by CycloneDX SBOMs via
     * the "licenses" property of the v1.6 specification.
     *
     * @private
     * @param {string} npmLicense
     *     The value of the "license" property of an NPM package, which is a
     *     string containing either a single SPDX identifier or an SPDX
     *     expression.
     *
     * @return {Object[]}
     *     A valid value for the "licenses" property of the CycloneDX v1.6 SBOM
     *     specification, containing the same information as provided from NPM
     *     wherever possible.
     */
    static #toSBOMLicenses(npmLicense) {

        // Reference valid SPDX identifiers directly
        if (/^[A-Za-z0-9+.]+/.exec(npmLicense)) {
            return [{
                'license' : {
                    'id' : npmLicense
                }
            }];
        }

        // Assume all other strings are SPDX expressions
        return [{
            'expression' : npmLicense
        }];

    }

    /**
     * Converts the given array of NPM "package.json" objects into a full
     * CycloneDX SBOM folliwng CycloneDX's v1.6 of their specification.
     *
     * @private
     * @param {Object[]} npmPackages
     *     The array of NPM package objects to translate into an SBOM.
     *
     * @return {*}
     *     A CycloneDX SBOM representing the same set of dependencies as the
     *     given array of NPM packages.
     */
    static #toSBOM(npmPackages) {

        //
        // NOTE: The generated SBOM follows CycloneDX's specification v1.6:
        //
        //     https://cyclonedx.org/docs/1.6/json/
        //
        // While the format assumed for NPM's package.json is based on the
        // published online documentation from NPM:
        //
        //     https://docs.npmjs.com/cli/v11/configuring-npm/package-json
        //

        const sbom = {

            'bomFormat' : 'CycloneDX',
            'specVersion' : '1.6',
            'serialNumber' : 'urn:uuid:' + uuidv4(),
            'version' : 1,
            'metadata' : {
                'timestamp' : new Date().toISOString()
            },

            'components' : [],
            'dependencies' : []

        };

        // Add translated component and dependency entries for each NPM
        // dependency
        npmPackages.forEach(npmPackage => {

            // Dependencies are uniquely referenced by their "purl" (package
            // URL, as defined by https://docs.npmjs.com/cli/v11/configuring-npm/package-json)
            const purl = 'pkg:npm/' + encodeURIComponent(npmPackage.name).replace('%2F', '/')
                + '@' + encodeURIComponent(npmPackage.version);

            // Produce base SBOM component for the dependency in question (this
            // will be separately referenced as a dependency later)
            const component = {
                'type' : 'library',
                'bom-ref' : purl,
                'name' : npmPackage.name,
                'version' : npmPackage.version,
                'purl' : purl
            };

            // Authorship, human-readable description, and license information
            // are all optional and only translated from the NPM format if
            // available

            if (npmPackage.author) {
                component.authors = DependencyListPlugin.#toSBOMAuthors(npmPackage.author);
            }

            if (npmPackage.description) {
                component.description = npmPackage.description;
            }

            if (npmPackage.license) {
                component.licenses = DependencyListPlugin.#toSBOMLicenses(npmPackage.license);
            }

            // Produce SBOM dependency referencing the component by its "purl"
            const dependency = {
                'ref' : purl
            };

            sbom.components.push(component);
            sbom.dependencies.push(dependency);

        });

        return sbom;

    }

    /**
     * Entrypoint for all Webpack plugins. This function will be invoked when
     * the plugin is being associated with the compile process.
     *
     * @param {Compiler} compiler
     *     A reference to the Webpack compiler.
     */
    apply(compiler) {

        /**
         * Logger for this plugin.
         *
         * @type {Logger}
         */
        const logger = compiler.getInfrastructureLogger(PLUGIN_NAME);

        /**
         * The directory receiving the dependency list file.
         *
         * @type {string}
         */
        const outputPath = this.options.path || compiler.options.output.path;

        /**
         * The full path to the output file that should contain the list of
         * discovered NPM module dependencies.
         *
         * @type {string}
         */
        const outputFile = path.join(
            outputPath,
            this.options.filename || 'npm-dependencies.txt'
        );

        /**
         * The full path to the output file that should contain the generated
         * SBOM.
         *
         * @type {string}
         */
        const sbomFile = path.join(
            outputPath,
            this.options.sbomFilename || 'npm-sbom.json'
        );

        // Wait for compilation to fully complete
        compiler.hooks.done.tap(PLUGIN_NAME, (stats) => {

            const moduleCoords = {};

            // Map each file used within any bundle built by the compiler to
            // its corresponding NPM package, ignoring files that have no such
            // package
            stats.compilation.fileDependencies.forEach(file => {

                // Locate NPM package corresponding to file dependency (there
                // may not be one)
                const npmPackage = DependencyListPlugin.#findPackage(file);

                // Translate absolute path into more readable path relative to
                // root of compilation process
                const relativePath = path.relative(compiler.options.context, file);

                if (npmPackage?.name) {
                    moduleCoords[npmPackage.name + ':' + npmPackage.version] = npmPackage;
                    logger.info('File dependency "%s" mapped to NPM package "%s" (v%s)',
                        relativePath, npmPackage.name, npmPackage.version);
                }
                else
                    logger.info('Skipping file dependency "%s" (no NPM package)',
                        relativePath);

            });

            // Create output path if it doesn't yet exist
            if (!fs.existsSync(outputPath))
                fs.mkdirSync(outputPath, { recursive: true, mode: 0o755 });

            // Write all discovered NPM packages to configured output file
            const sortedCoords = Object.keys(moduleCoords).sort();
            fs.writeFileSync(outputFile, sortedCoords.join('\n') + '\n');

            const sbom = DependencyListPlugin.#toSBOM(Object.values(moduleCoords));
            fs.writeFileSync(sbomFile, JSON.stringify(sbom, null, 4));

        });

    }

}

module.exports = DependencyListPlugin;

