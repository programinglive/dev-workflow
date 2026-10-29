export function assertSafeToolCommand(name,args) {
  const command=name==='perform_release'?args.command:name==='run_full_workflow'?args.releaseCommand:undefined;
  if(command && !/^(?:(?:major|minor|patch)|npm(?:\.cmd)? run release(?::(?:major|minor|patch))?(?: -- (?:--release-as (?:major|minor|patch)|--first-release))?)$/.test(command.trim())) {
    const error=new Error('Strict mode permits npm run release[:major|minor|patch] only. Arbitrary shell commands and file reads are denied. Run custom release actions in a trusted operator session.');
    error.code='UNSAFE_COMMAND_DENIED'; throw error;
  }
  if(args.branch && !/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(args.branch)) {
    const error=new Error('Unsafe branch syntax denied');error.code='UNSAFE_COMMAND_DENIED';throw error;
  }
}
