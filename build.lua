-- lazy.nvim runs this after installing or updating the plugin: download the language
-- server for this version now, rather than when the first ca65 file is opened.
local server = require("ca65.server")
if server.path() then return end
local failure
server.install({ sync = true, on_done = function(err) failure = err end })
if failure then error("ca65: couldn't download the language server: " .. failure) end
