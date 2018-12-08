module.exports = function(grunt) {

    grunt.initConfig({
        pkg: grunt.file.readJSON('package.json'),
        bump: {
            options: {
                files: ['module.json'],
                commitMessage: 'Release %VERSION%',
                commitFiles: ['module.json'],
                createTag: true,
                tagName: '%VERSION%',
                push: true,
                pushTo: 'origin'
            }
        },
        compress: {
            main: {
                options: {
                    archive: 'out/Zway-MQTT.tar.gz'
                },
                files: [
                    {
                        src: ['index.js', 'module.json', 'README.md', 'htdocs/**', 'lang/**', 'lib/**'],
                        dest: ''
                    }
                ]
            }
        }
    });

    grunt.loadNpmTasks('grunt-bump');
    grunt.loadNpmTasks('grunt-contrib-compress');

    grunt.registerTask('default', ['compress']);

};