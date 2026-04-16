console.log('App loaded from app.js');
// This script references resources
document.addEventListener('DOMContentLoaded', function() {
    var links = document.querySelectorAll('a[href]');
    console.log('Found ' + links.length + ' links');
});