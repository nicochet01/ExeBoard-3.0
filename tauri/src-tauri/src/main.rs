// Em release não abre janela de console.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod bitbucket;
mod branch;
mod config;
mod copy;
mod dpapi;
mod index;
mod services;
mod state;
mod ui_cmds;
mod util;

fn main() {
    app::run();
}
