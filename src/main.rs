fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(imp_aly::commands::main(&argv));
}
