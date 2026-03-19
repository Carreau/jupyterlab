#!/bin/bash

# Copyright (c) Jupyter Development Team.
# Distributed under the terms of the Modified BSD License.
set -ex
set -o pipefail

# Timing helper
TOTAL_START=$(date +%s)
step_time() {
    local step_start=$1
    local step_name=$2
    local step_end=$(date +%s)
    echo "⏱  ${step_name}: $((step_end - step_start))s"
}

# use a single global cache dir
export YARN_ENABLE_GLOBAL_CACHE=1

# display verbose output for pkg builds run during `jlpm install`
export YARN_ENABLE_INLINE_BUILDS=1


# Building should work without yarn installed globally, so uninstall the
# global yarn installed by default.
if [ $OSTYPE == "linux-gnu" ]; then
    sudo rm -rf $(which yarn)
    ! yarn
fi

# create jupyter base dir (needed for config retrieval)
mkdir -p ~/.jupyter

# Set up git config
git config --global user.name foo
git config --global user.email foo@bar.com

# Install uv for fast Python package management (10-100x faster than pip)
START=$(date +%s)
if ! command -v uv &>/dev/null; then
    curl -LsSf https://astral.sh/uv/install.sh | sh
    # Add uv to PATH for the remainder of this script
    export PATH="$HOME/.local/bin:$PATH"
fi
uv --version
step_time $START "uv install"

if [[ -z "${OPTIONAL_DEPENDENCIES+x}" ]]; then
    # undefined - use default dev,test
    SPEC=".[dev,test]"
elif [[ -z "${OPTIONAL_DEPENDENCIES}" ]]; then
    # defined but empty
    SPEC="."
else
    # defined and non-empty
    SPEC=".[${OPTIONAL_DEPENDENCIES}]"
fi

# Install and enable the server extension
# Show a verbose install if the install fails, for debugging
START=$(date +%s)
uv pip install -e "${SPEC}" || uv pip install -v -e "${SPEC}"
step_time $START "uv pip install -e ${SPEC}"

START=$(date +%s)
node -p process.versions
jlpm config
step_time $START "node/jlpm config"

if [[ $GROUP != js-services ]]; then
    # Tests run much faster in ipykernel 6, so use that except for
    # ikernel.spec.ts in js-services, which tests subshell compatibility in
    # ipykernel 7.
    START=$(date +%s)
    uv pip install "ipykernel<7"
    step_time $START "uv pip install ipykernel"
fi

if [[ $GROUP == nonode ]]; then
    # Build the wheel
    START=$(date +%s)
    uv pip install build
    python -m build .
    step_time $START "wheel build"

    # Remove NodeJS, twice to take care of system and locally installed node versions.
    sudo rm -rf $(which node)
    sudo rm -rf $(which node)
    ! node
fi

TOTAL_END=$(date +%s)
echo ""
echo "========================================="
echo "⏱  Total ci_install.sh: $((TOTAL_END - TOTAL_START))s"
echo "========================================="
