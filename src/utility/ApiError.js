class ApiError extends Error{
    constructor(
        statuscode,
        message = "Something Went Wrong..!",
        errors = [],
        stack = ""
    ){
        super(message)
        this.data=null
        this.statuscode = statuscode
        this.message = message
        this.success = false
        this.errors = errors

        if(stack){
            this.stack = stack
        }else{
            Error.captureStackTrace(this,this.constructor)
        }
    }
}
export {ApiError}