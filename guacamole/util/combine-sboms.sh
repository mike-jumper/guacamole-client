#!/bin/sh
#
# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.
#

#
# combine-sboms.sh - Convenience script for automatically running the CycloneDX
# CLI tool to merge a provided list of SBOM files. If the CycloneDX CLI tool is
# not installed, an informative error is printed.
#
# The first argument provided to this script on the command line is the output
# file that should receive the combined output. All other arguments following
# the first are interpreted as input SBOM files to be combined.
#

if ! command -v cyclonedx > /dev/null; then
    echo "To generate a combined SBOM for the Apache Guacamole web application, the CycloneDX CLI tool must be installed and available in the PATH as \"cyclonedx\". Bailing out now."
    exit 1
fi

##
## The file that should receive the final combined SBOM output.
##
OUTPUT_FILE="$1"
shift

# Ensure destination directory exists
mkdir -p "`dirname "$OUTPUT_FILE"`"

# Merge all provided SBOM files
cyclonedx merge --input-files "$@" --output-file "$OUTPUT_FILE"
