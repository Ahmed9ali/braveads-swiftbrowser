use std::path::Path;
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let war = Path::new(&a[1]);
    let map = Path::new(&a[2]);
    let res = adblock::resources::resource_assembler::assemble_web_accessible_resources(war, map);
    println!("{}", serde_json::to_string(&res).unwrap());
}
