module.exports = {
    transform: {
        '^.+\\.ts?$': 'ts-jest'
    },
    testEnvironment: 'node',
    testRegex: 'specs/index.ts',
    moduleFileExtensions: ['ts', 'js'],
    testPathIgnorePatterns: [
        '<rootDir>/(build|bin|dist|node_modules)/'
    ],
    // src/utils/http_request.ts branches on BUILD_ENV to pick node-fetch over
    // window.fetch; without this the test runner throws "window is not defined".
    testEnvironmentOptions: {
        env: { BUILD_ENV: 'node' }
    },
};
